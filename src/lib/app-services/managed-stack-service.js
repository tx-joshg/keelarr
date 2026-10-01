import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";

import { readComposeImage, setComposeImage, writeStacks } from "../generator.js";
import {
  backupService,
  composeDown,
  ensureSharedNetwork,
  explainDeployFailure,
  findRollbackPoint,
  imageExistsLocally,
  readConfigMountSource,
  readContainerImageIdByName,
  restartService,
  restoreConfigSnapshot
} from "../runtime.js";
import { SHARED_NETWORK, getServiceDefinition, isImportedMode } from "../service-catalog.js";
import { HEALTH_OUTCOME, verifyServiceHealth } from "../health.js";
import { JobRegistry } from "../jobs.js";
import {
  checkForUpdates,
  generateAndDeploy,
  installService,
  upgradeAllServices,
  upgradeService
} from "../runtime.js";
import {
  appendActivity,
  loadSettings,
  readAutoUpdateState,
  readUpdateState,
  writeAutoUpdateState,
  writeUpdateState
} from "../store.js";
import { AUTO_UPDATE_TOLERANCE_MS, decideAutoUpdate, describeNextRun } from "../auto-update-window.js";
import { isValidTimeZone, parseClockTime } from "../clock.js";
import { KeelarrError } from "../errors.js";
import { defaultLogger } from "../logger.js";

/**
 * How often the stack asks the registry whether anything has moved.
 *
 * Daily, because these images publish at most a few times a week and every
 * check is a pull against every image in the stack.
 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const ROLLBACK_STEPS = [
  { name: "preflight", label: "Find the previous image" },
  { name: "backup", label: "Back up the current state" },
  { name: "restore-config", label: "Restore the saved configuration" },
  { name: "pin", label: "Pin the stack to the previous image" },
  { name: "deploy", label: "Recreate the container on that image" },
  { name: "verify", label: "Confirm the service is healthy" },
  { name: "restore", label: "Undo the pin" },
  { name: "finalize", label: "Record the rollback" }
];

export class ManagedStackService {
  constructor({
    appendActivityImpl = appendActivity,
    backupServiceImpl = backupService,
    checkForUpdatesImpl = checkForUpdates,
    ensureSharedNetworkImpl = ensureSharedNetwork,
    findRollbackPointImpl = findRollbackPoint,
    generateAndDeployImpl = generateAndDeploy,
    hostProfileService = null,
    imageExistsLocallyImpl = imageExistsLocally,
    composeDownImpl = composeDown,
    readConfigMountSourceImpl = readConfigMountSource,
    restartServiceImpl = restartService,
    restoreConfigSnapshotImpl = restoreConfigSnapshot,
    installServiceImpl = installService,
    jobs = null,
    loadSettingsImpl = loadSettings,
    logger = defaultLogger,
    readComposeImageImpl = readComposeImage,
    readContainerImageIdImpl = readContainerImageIdByName,
    readUpdateStateImpl = readUpdateState,
    readAutoUpdateStateImpl = readAutoUpdateState,
    writeAutoUpdateStateImpl = writeAutoUpdateState,
    lease = null,
    leaseHeartbeatMs = 60_000,
    // Long enough to catch a container that starts and exits, short enough not
    // to add minutes to a revert that has already gone wrong. Injectable so the
    // tests do not wait on it.
    recoveryVerifyTimeoutMs = 15_000,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    setComposeImageImpl = setComposeImage,
    upgradeAllServicesImpl = upgradeAllServices,
    upgradeServiceImpl = upgradeService,
    verifyServiceHealthImpl = verifyServiceHealth,
    verifyOptions = {},
    writeStacksImpl = writeStacks,
    writeUpdateStateImpl = writeUpdateState
  } = {}) {
    this.backupService = backupServiceImpl;
    this.ensureSharedNetwork = ensureSharedNetworkImpl;
    this.findRollbackPoint = findRollbackPointImpl;
    this.imageExistsLocally = imageExistsLocallyImpl;
    this.restoreConfigSnapshot = restoreConfigSnapshotImpl;
    this.composeDown = composeDownImpl;
    this.readConfigMountSource = readConfigMountSourceImpl;
    this.restartService = restartServiceImpl;
    this.jobs = jobs;
    this.readComposeImage = readComposeImageImpl;
    this.readContainerImageId = readContainerImageIdImpl;
    this.setComposeImage = setComposeImageImpl;
    this.verifyServiceHealth = verifyServiceHealthImpl;
    this.verifyOptions = verifyOptions;
    this.appendActivity = appendActivityImpl;
    this.checkForUpdates = checkForUpdatesImpl;
    this.generateAndDeploy = generateAndDeployImpl;
    this.hostProfileService = hostProfileService;
    this.installService = installServiceImpl;
    this.loadSettingsImpl = loadSettingsImpl;
    this.logger = logger.child({
      component: "managed-stack-service"
    });
    this.readUpdateState = readUpdateStateImpl;
    this.readAutoUpdateState = readAutoUpdateStateImpl;
    this.writeAutoUpdateState = writeAutoUpdateStateImpl;
    // Every change to auto-update.json goes through updateAutoUpdateState,
    // one at a time, as a function of what is on disk at that moment. Two
    // writers that each read, spread and write — the tick undoing a claim
    // and a Run Now recording itself — would otherwise put each other's
    // fields back.
    this.autoUpdateStateQueue = Promise.resolve();
    this.lease = lease;
    this.leaseHeartbeatMs = leaseHeartbeatMs;
    this.recoveryVerifyTimeoutMs = recoveryVerifyTimeoutMs;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.upgradeAllServices = upgradeAllServicesImpl;
    this.upgradeService = upgradeServiceImpl;
    this.writeStacks = writeStacksImpl;
    this.writeUpdateState = writeUpdateStateImpl;
  }

  async loadSettings() {
    if (this.hostProfileService) {
      return this.hostProfileService.loadSettings();
    }

    return this.loadSettingsImpl();
  }

  requireService(settings, serviceId) {
    const service = settings.services[serviceId];

    if (!service) {
      throw new KeelarrError(`Unknown or disabled service: ${serviceId}`, {
        statusCode: 404
      });
    }

    return service;
  }

  scopedLogger(context = {}) {
    return context.requestId
      ? this.logger.child({ requestId: context.requestId })
      : this.logger;
  }

  /**
   * A rollback pins compose.yml to an image digest. Upgrading has to restore
   * the tag first, or the pull would just re-resolve the pinned digest and the
   * service could never move forward again.
   */
  async clearRollbackPin(service, logger) {
    if (!(await this.serviceIsDeployed(service))) {
      return false;
    }

    const current = await this.readComposeImage(service);

    if (!current || current === service.image || !/@sha256:|^sha256:/.test(current)) {
      return false;
    }

    await this.setComposeImage(service, service.image);
    logger.info("service.rollback_pin_cleared", {
      serviceId: service.id,
      from: current,
      to: service.image
    });
    return true;
  }

  /**
   * Catalog stacks declare the shared network as external, so it must exist
   * before the first deploy. Imported stacks keep whatever network the live
   * container was on and are left alone.
   */
  async prepareNetwork(settings, service, logger) {
    if (isImportedMode(service.managedMode)) {
      return;
    }

    const result = await this.ensureSharedNetwork(settings, SHARED_NETWORK, { logger });

    if (!result.ok) {
      throw new KeelarrError(`Unable to create the shared ${SHARED_NETWORK} network: ${result.error || "unknown error"}`, {
        statusCode: 500
      });
    }

    if (result.created) {
      logger.info("network.created", { network: SHARED_NETWORK });
    }
  }

  /**
   * When the stack was last asked the registry anything.
   *
   * Newest wins: services are checked in sequence and a single failure should
   * not make the whole stack look overdue.
   */
  lastUpdateCheckAt(updateState) {
    const stamps = Object.values(updateState || {})
      .map((entry) => entry?.checkedAt)
      .filter(Boolean)
      .sort();

    return stamps.length ? stamps[stamps.length - 1] : null;
  }

  isUpdateCheckDue(updateState, { now = Date.now(), intervalMs = UPDATE_CHECK_INTERVAL_MS } = {}) {
    const last = this.lastUpdateCheckAt(updateState);

    if (!last) {
      return true;
    }

    const parsed = Date.parse(last);
    // An unparseable stamp is not evidence of a recent check.
    return !Number.isFinite(parsed) || now - parsed >= intervalMs;
  }

  /**
   * Checks for updates on a timer, and never anywhere else.
   *
   * A check is a `compose pull` of every image in the stack, so it is far too
   * expensive to do implicitly — doing it inside Upgrade All meant asking the
   * registry about nine services to act on three. It happens here, right after
   * an install, or when the operator asks. Nothing else triggers one.
   */
  /**
   * Once a minute, asks whether the install window is open. A missed window is
   * not caught up at boot, by decision — see decideAutoUpdate.
   */
  startAutoUpdateSchedule({
    tickMs = 60_000,
    toleranceMs = AUTO_UPDATE_TOLERANCE_MS,
    nowImpl = Date.now,
    setIntervalImpl = setInterval
  } = {}) {
    const tick = async () => {
      try {
        await this.runAutoUpdateTick({ now: nowImpl(), toleranceMs });
      } catch (error) {
        this.logger.warn("auto_update.tick_failed", { message: error.message });
      }
    };

    const timer = setIntervalImpl(tick, tickMs);
    timer.unref?.();

    return () => clearInterval(timer);
  }

  updateAutoUpdateState(change) {
    const next = this.autoUpdateStateQueue.then(async () => {
      const current = await this.readAutoUpdateState();
      const updated = change(current);

      if (updated !== current) {
        await this.writeAutoUpdateState(updated);
      }

      return updated;
    });

    // A failed write must not wedge every later one behind it.
    this.autoUpdateStateQueue = next.catch(() => {});

    return next;
  }

  async runAutoUpdateTick({ now = Date.now(), toleranceMs = AUTO_UPDATE_TOLERANCE_MS } = {}) {
    // A tick that outlives the interval — slow state I/O — must not be joined
    // by the next one: both would read an unclaimed window, and the second
    // would then undo the first's claim on being refused.
    if (this.autoUpdateTickInProgress) {
      return { ran: false, reason: "tick-in-progress" };
    }

    this.autoUpdateTickInProgress = true;

    try {
      return await this.runAutoUpdateTickOnce({ now, toleranceMs });
    } finally {
      this.autoUpdateTickInProgress = false;
    }
  }

  async runAutoUpdateTickOnce({ now, toleranceMs }) {
    const settings = await this.loadSettings();
    const state = await this.readAutoUpdateState();
    const decision = decideAutoUpdate({ now, settings, state, toleranceMs });

    if (!decision.run) {
      return { ran: false, reason: decision.reason, windowKey: decision.windowKey || null };
    }

    if (decision.tzFallback) {
      this.logger.warn("auto_update.invalid_tz", { tz: settings.tz });
    }

    // Stand aside and leave the window unclaimed, so the next tick tries again
    // while it is still open. A cutover or a controller update in progress is
    // not something to start an upgrade underneath.
    if (this.jobs?.list().some((job) => job.status === "running")) {
      return { ran: false, reason: "job-running", windowKey: decision.windowKey };
    }

    if (this.lease?.isHeld()) {
      return { ran: false, reason: "lease-held", windowKey: decision.windowKey };
    }

    if (this.lease?.isBusy?.()) {
      return { ran: false, reason: "action-in-progress", windowKey: decision.windowKey };
    }

    const optedIn = settings.selectedServiceIds
      .map((serviceId) => settings.services[serviceId])
      .filter((service) => service && service.autoUpdate === true);

    // Claimed before any work starts: a ten-minute job must not be started a
    // second time by the ticks that fire while it runs, and a crash mid-run
    // must not re-run at the next tick.
    const claim = {
      lastWindowKey: decision.windowKey,
      lastRunAt: new Date(now).toISOString(),
      lastTrigger: "scheduled",
      lastJobId: null,
      lastSummary: null,
      finishedAt: null
    };
    await this.updateAutoUpdateState((current) => ({ ...current, ...claim }));

    if (optedIn.length === 0) {
      await this.updateAutoUpdateState((current) => ({ ...current, lastSummary: { reason: "nothing-opted-in" } }));
      return { ran: false, reason: "nothing-opted-in", windowKey: decision.windowKey };
    }

    let job;

    try {
      job = this.startAutoUpdate(settings, optedIn, { trigger: "scheduled" });
    } catch (error) {
      // The lease was taken between the check above and this — a controller
      // update pressed at 03:00 sharp. The claim is undone so the next tick
      // tries again while the window is open, instead of every tick that
      // night answering "already ran" for a run that never started. Only the
      // claim: a Run Now that got in meanwhile has written its own job id and
      // must not be erased by putting the earlier snapshot back.
      await this.updateAutoUpdateState((current) => {
        if (current.lastWindowKey !== decision.windowKey) {
          return current;
        }

        if (current.lastJobId === null && current.lastSummary === null) {
          return state;
        }

        // A scheduled run for this window got in first: the claim is its,
        // and stays. Only a manual run's record is left with the key reset.
        return current.lastTrigger === "scheduled"
          ? current
          : { ...current, lastWindowKey: state.lastWindowKey ?? null };
      });

      this.logger.warn("auto_update.start_refused", { message: error.message });
      return { ran: false, reason: "lease-held", windowKey: decision.windowKey };
    }

    return { ran: true, jobId: job.id, windowKey: decision.windowKey };
  }

  /**
   * One step per opted-in service, including the ones it then leaves alone.
   * Upgrade All hides non-work because someone is watching; this run is read
   * the next morning, and "looked at Sonarr, already current" is the record
   * they want.
   */
  startAutoUpdate(settings, services, context = {}) {
    // Held for the whole run, not just checked at the start. The job registry
    // only refuses a second job of the same kind and subject, so without this
    // an operator could start a removal or a cutover underneath an upgrade
    // that nobody is watching. Taken before the job exists so a refusal
    // leaves nothing behind.
    // The tick stands aside for a running job; Run Now must too. A cutover
    // or removal answers its request as soon as its job is registered, and
    // the job keeps working — taking a container down, renaming — long after
    // the manual action that started it has settled.
    if (this.jobs?.list().some((job) => job.status === "running")) {
      throw new KeelarrError("A scheduled update cannot start while another job is running. Wait for it to finish.", {
        statusCode: 409
      });
    }

    const operationId = `auto-update-${randomUUID()}`;
    this.lease?.acquire({
      reason: "A scheduled update",
      operationId,
      detail: "It is upgrading apps unattended. Wait for it to finish, or follow it in Activity."
    });

    const job = this.requireJobs().create({
      kind: "auto-update",
      subject: { serviceId: "*" },
      steps: [
        { name: "check", label: "Check for updates" },
        ...services.map((service) => ({ name: service.id, label: `Upgrade ${service.name}` }))
      ]
    });
    const trigger = context.trigger || "scheduled";
    // A single pull has no deadline — it is judged on progress — so one
    // phase can outlive the lease's term on its own. The heartbeat renews
    // for as long as the run is alive, whatever it is doing.
    const heartbeat = this.setIntervalImpl(() => this.lease?.renew(operationId), this.leaseHeartbeatMs);
    heartbeat.unref?.();

    return this.jobs.start(job, async (ctx) => {
      try {
        // The tick records a scheduled run when it claims the window. A run
        // started by hand has no window to claim, but it is still the last
        // run, and its summary must not be filed under the previous one's id.
        // Never the window key: that is the tick's alone, and a Run Now that
        // happened to read a claim the tick was about to undo must not put
        // it back.
        // Bookkeeping. If the write fails, the run still happens: the window
        // is already claimed, and a claimed window with no run is the one
        // outcome worse than a run with no record.
        await this.updateAutoUpdateState((current) => ({
          ...current,
          lastRunAt: new Date().toISOString(),
          lastTrigger: trigger,
          lastJobId: job.id,
          lastSummary: null,
          finishedAt: null
        })).catch((error) => {
          this.logger.warn("auto_update.record_failed", { jobId: job.id, message: error.message });
        });

        return await this.runAutoUpdate(ctx, settings, services, { ...context, trigger, leaseOperationId: operationId });
      } finally {
        this.clearIntervalImpl(heartbeat);
        this.lease?.release(operationId);
      }
    });
  }

  async runAutoUpdate(ctx, settings, services, context = {}) {
    const logger = this.scopedLogger(context);

    // A pull that fails — the registry is down, a token expired — comes back
    // as ok:false for that service while the check as a whole still succeeds.
    // Left unread, an outage would file as a clean unattended run.
    const checkErrors = new Map();
    // The lease has a fixed term so a controller killed mid-run cannot wedge
    // the stack. A run that is still working renews it as it goes.
    const keepAlive = () => this.lease?.renew(context.leaseOperationId);

    keepAlive();
    await ctx.step("check", async () => {
      const checked = await this.checkAllUpdates(
        { ...context, trigger: "auto-update" },
        { serviceIds: services.map((service) => service.id) }
      );
      const ready = checked.results.filter((result) => result.updateStatus === "ready").length;

      for (const result of checked.results) {
        if (result.ok === false) {
          checkErrors.set(result.serviceId, result.error || "the image could not be checked");
        }
      }

      const failed = checkErrors.size ? ` ${checkErrors.size} could not be checked.` : "";

      return { detail: `${ready} of ${services.length} ${ready === 1 ? "has" : "have"} an update.${failed}` };
    });

    const updateState = await this.readUpdateState();
    const plan = this.planUpgradeAll(services, updateState);
    const inPlan = (bucket, service) => bucket.some((entry) => entry.id === service.id);
    const upgradable = [];
    const unchecked = [];
    let skipped = 0;

    for (const service of services) {
      keepAlive();

      // First, because a stale "ready" from before the stack was removed
      // would otherwise put it in the plan. The check above skipped it
      // without writing a status, so the run asks the same question.
      if (!(await this.serviceIsDeployed(service))) {
        ctx.skip(service.id, "Not deployed by Keelarr, not touched.");
        skipped += 1;
        continue;
      }

      if (checkErrors.has(service.id)) {
        try {
          await ctx.step(service.id, async () => {
            throw new KeelarrError(`The update check failed, so it was not touched: ${checkErrors.get(service.id)}`, { statusCode: 500 });
          });
        } catch (error) {
          unchecked.push({ serviceId: service.id, ok: false, unchecked: true, error: error.message });
        }
        continue;
      }

      // A reverted service reports "ready" at every check — the check above
      // just overwrote its status — because its compose file is pinned to a
      // digest and the tag has moved on. Without this it would be upgraded,
      // fail and be reverted again every night. The pin is the durable signal:
      // a revert or a rollback leaves it, and only a person pressing Upgrade
      // clears it. That is the answer this waits for.
      if (await this.isPinnedToPreviousImage(service)) {
        ctx.skip(service.id, "Reverted after its last upgrade. Upgrade it manually to move forward.");
        skipped += 1;
      } else if (inPlan(plan.upgradable, service)) {
        upgradable.push(service);
      } else if (inPlan(plan.current, service)) {
        ctx.skip(service.id, "Already current.");
        skipped += 1;
      } else {
        ctx.skip(service.id, "Update state unknown, not touched.");
        skipped += 1;
      }
    }

    const upgradeResults = await this.upgradeAsSteps(ctx, settings, upgradable, logger, { keepAlive });
    const results = [...upgradeResults, ...unchecked];
    const upgraded = upgradeResults.filter((result) => result.ok && !result.skipped).length;
    // "Reverted" is a recovery. An app put back on its previous image that
    // did not come up either is down, and is counted with the failures.
    const reverted = upgradeResults.filter((result) => result.reverted === true && result.revertedDown !== true).length;
    const failedOutright = upgradeResults.filter((result) => !result.ok && (result.reverted !== true || result.revertedDown === true)).length;
    const summary = { upgraded, reverted, failed: failedOutright, unchecked: unchecked.length, skipped };
    const message = `Scheduled update: ${upgraded} upgraded${reverted ? `, ${reverted} reverted` : ""}${
      failedOutright ? `, ${failedOutright} failed` : ""
    }${unchecked.length ? `, ${unchecked.length} could not be checked` : ""}, ${skipped} left alone.`;
    const level = reverted || failedOutright ? "error" : unchecked.length ? "warn" : "info";

    await this.appendActivity({
      kind: "auto-update",
      level,
      message,
      details: results
    });

    await this.updateAutoUpdateState((current) => ({
      ...current,
      lastTrigger: context.trigger || current.lastTrigger || "scheduled",
      finishedAt: new Date().toISOString(),
      lastSummary: summary
    }));
    logger[level === "info" ? "info" : level]("service.auto_update", summary);

    return { ...summary, results, summary: message };
  }

  /**
   * Whether the compose file still points at a digest rather than the tag —
   * the state a revert or a rollback leaves behind, and the same test
   * clearRollbackPin applies before moving forward.
   */
  async isPinnedToPreviousImage(service) {
    try {
      const image = await this.readComposeImage(service);
      return /@sha256:|^sha256:/.test(String(image || "")) && image !== service.image;
    } catch {
      return false;
    }
  }

  /** What the dashboard needs to say about scheduled installs. Cheap; no Docker. */
  async describeAutoUpdate() {
    const settings = await this.loadSettings();
    const state = await this.readAutoUpdateState();
    const enabled = settings.autoUpdateEnabled === true;
    const target = parseClockTime(settings.autoUpdateTime);

    return {
      enabled,
      time: settings.autoUpdateTime,
      tz: settings.tz,
      tzValid: isValidTimeZone(settings.tz),
      toleranceMinutes: AUTO_UPDATE_TOLERANCE_MS / 60_000,
      nextRunAt: enabled && target ? describeNextRun({ now: Date.now(), settings, state }) : null,
      lastRunAt: state.lastRunAt || null,
      lastTrigger: state.lastTrigger || null,
      lastWindowKey: state.lastWindowKey || null,
      lastJobId: state.lastJobId || null,
      lastSummary: state.lastSummary || null,
      optedIn: settings.selectedServiceIds.filter((serviceId) => settings.services[serviceId]?.autoUpdate === true)
    };
  }

  startUpdateSchedule({
    intervalMs = UPDATE_CHECK_INTERVAL_MS,
    startupDelayMs = 60_000,
    nowImpl = Date.now,
    setIntervalImpl = setInterval,
    setTimeoutImpl = setTimeout
  } = {}) {
    const runCheck = async (trigger) => {
      try {
        // A check competing with an upgrade would have two pulls of the same
        // image in flight, and the upgrade is the one that matters.
        if (this.jobs?.list().some((job) => job.status === "running")) {
          return;
        }

        await this.checkAllUpdates({ trigger });
      } catch (error) {
        // A failed check must never take the controller down with it; the
        // stored state simply stays as it was until the next one.
        this.logger.warn("update.scheduled_check_failed", { trigger, message: error.message });
      }
    };

    const startupTimer = setTimeoutImpl(async () => {
      if (this.isUpdateCheckDue(await this.readUpdateState(), { now: nowImpl(), intervalMs })) {
        await runCheck("startup");
      }
    }, startupDelayMs);

    const timer = setIntervalImpl(() => runCheck("scheduled"), intervalMs);

    // Neither timer is a reason for the process to stay alive.
    startupTimer.unref?.();
    timer.unref?.();

    return () => {
      clearTimeout(startupTimer);
      clearInterval(timer);
    };
  }

  /**
   * A deploy or upgrade has just resolved the tag, so whatever the previous
   * update status was is stale. Leaving it would report an upgraded service as
   * still needing an update, or keep showing "rolled-back" after moving on.
   */
  async recordFreshImageState(serviceId, { upgradedAt = null } = {}) {
    const updateState = await this.readUpdateState();
    // Spread the previous entry: an install or a check must not erase the
    // record of when this service was last upgraded.
    updateState[serviceId] = {
      ...(updateState[serviceId] || {}),
      status: "current",
      checkedAt: new Date().toISOString(),
      ...(upgradedAt ? { upgradedAt } : {})
    };
    await this.writeUpdateState(updateState);
  }

  /**
   * Marks a service as pinned to its previous image. The last upgrade time is
   * kept: it records the last upgrade that stuck, and this one did not.
   */
  async recordRolledBackState(serviceId) {
    const updateState = await this.readUpdateState();
    updateState[serviceId] = {
      ...(updateState[serviceId] || {}),
      status: "rolled-back",
      checkedAt: new Date().toISOString()
    };
    await this.writeUpdateState(updateState);
  }

  requireJobs() {
    if (!this.jobs) {
      this.jobs = new JobRegistry({ logger: this.logger, persist: true });
    }

    return this.jobs;
  }

  /**
   * Reports whether a service can be rolled back, so the dashboard can offer
   * the action only when there is somewhere to roll back to.
   */
  async describeRollbackPoint(settings, service) {
    if (!(await this.serviceIsDeployed(service))) {
      return null;
    }

    const point = await this.findRollbackPoint(settings, service);

    if (!point) {
      return null;
    }

    return {
      backedUpAt: point.backedUpAt,
      imageRef: point.imageRef,
      taggedImage: point.taggedImage,
      // Lets the dashboard offer a config restore only when one was captured.
      hasConfigSnapshot: Boolean(point.configSnapshot)
    };
  }

  startRollback(serviceId, input = {}, context = {}) {
    const job = this.requireJobs().create({
      kind: "rollback",
      subject: { serviceId },
      steps: ROLLBACK_STEPS
    });

    return this.jobs.start(job, (ctx) => this.runRollback(ctx, serviceId, input, context));
  }

  async runRollback(ctx, serviceId, input, context) {
    const logger = this.scopedLogger(context);
    let plan = null;

    await ctx.step("preflight", async () => {
      const settings = await this.loadSettings();
      const service = this.requireService(settings, serviceId);

      if (input.confirmContainerName !== service.containerName) {
        throw new KeelarrError(
          `Rollback confirmation does not match. Expected the container name ${service.containerName}.`,
          { statusCode: 400 }
        );
      }

      if (!(await this.serviceIsDeployed(service))) {
        throw new KeelarrError(`${service.name} has no managed compose file to roll back.`, {
          statusCode: 409
        });
      }

      const point = await this.findRollbackPoint(settings, service, { logger });

      if (!point) {
        throw new KeelarrError(
          `No previous image is recorded for ${service.name}. Rollback is only available after an upgrade or install made a backup.`,
          { statusCode: 409 }
        );
      }

      // Rolling back to an image the host no longer has would leave the
      // service unable to start, so refuse before touching the container.
      if (!(await this.imageExistsLocally(settings, point.imageRef, { logger }))) {
        throw new KeelarrError(
          `The previous image for ${service.name} (${point.imageRef}) is no longer present on this host.`,
          { statusCode: 409 }
        );
      }

      const currentImage = await this.readComposeImage(service);
      // Read the /config mount now, while the container still exists. The
      // restore step removes it first, and a deleted container cannot be
      // inspected for its mounts.
      const configMount = input.restoreConfig && point.configSnapshot
        ? await this.readConfigMountSource(settings, service, { logger })
        : null;

      if (input.restoreConfig && point.configSnapshot && !configMount) {
        throw new KeelarrError(
          `Cannot restore configuration for ${service.name}: no /config mount was found on the running container.`,
          { statusCode: 409 }
        );
      }

      plan = { settings, service, point, currentImage, configMount };
      return { detail: `Rolling back to ${point.taggedImage || point.imageRef} from ${point.backedUpAt || "an earlier backup"}.` };
    });

    const { settings, service, point, currentImage, configMount } = plan;
    const stepLogger = logger.child({ serviceId: service.id, containerName: service.containerName });

    const backup = await ctx.step("backup", async () => {
      const result = await this.backupService(settings, service, { logger: stepLogger });
      return { detail: `Backed up to ${result.backupDir}.`, ...result };
    });

    if (input.restoreConfig && point.configSnapshot) {
      await ctx.step("restore-config", async () => {
        // Stop first: restoring the database under a running app would leave
        // it holding stale handles and half-written state.
        await this.composeDown(settings, service, { logger: stepLogger });
        const restored = await this.restoreConfigSnapshot(settings, service, point.backupDir, {
          logger: stepLogger,
          mount: configMount
        });

        if (!restored.ok) {
          // The service is down at this point. Bring it back before reporting,
          // rather than leaving it stopped on a failed restore.
          await this.generateAndDeploy(settings, service, { logger: stepLogger });
          throw new KeelarrError(`Unable to restore the saved configuration for ${service.name}: ${restored.reason}`, {
            statusCode: 500,
            details: { serviceRestarted: true }
          });
        }

        return { detail: `Restored configuration captured ${point.backedUpAt}.` };
      });
    } else {
      ctx.skip("restore-config", input.restoreConfig
        ? "No configuration snapshot was captured for this rollback point."
        : "Keeping current configuration.");
    }

    await ctx.step("pin", async () => {
      await this.setComposeImage(service, point.imageRef);
      return { detail: `Pinned ${service.name} to ${point.imageRef}.` };
    });

    const deployed = await ctx.step("deploy", async () => {
      const result = await this.generateAndDeploy(settings, service, { logger: stepLogger });

      if (!result.ok) {
        await this.undoPin(ctx, settings, service, currentImage, stepLogger);
        throw new KeelarrError(`Compose failed to start ${service.name} on the previous image.`, {
          statusCode: 500,
          details: { stdout: result.stdout, stderr: result.stderr, restored: true }
        });
      }

      return { detail: `Recreated ${service.name}.` };
    });

    const health = await ctx.step("verify", async () => {
      const result = await this.verifyServiceHealth(settings, service, {
        ...this.verifyOptions,
        logger: stepLogger
      });
      return { detail: result.reason, ...result };
    });

    if (health.outcome === HEALTH_OUTCOME.FAILED) {
      await this.undoPin(ctx, settings, service, currentImage, stepLogger);
      throw new KeelarrError(`${service.name} did not come up on the previous image. The newer image was restored.`, {
        statusCode: 500,
        details: { reason: health.reason, restored: true }
      });
    }

    ctx.skip("restore", "Not needed.");

    await ctx.step("finalize", async () => {
      await this.recordRolledBackState(service.id);

      await this.appendActivity({
        kind: "rollback",
        level: health.outcome === HEALTH_OUTCOME.VERIFIED ? "info" : "warn",
        message: `Rolled ${service.name} back to ${point.taggedImage || point.imageRef}.`,
        details: { serviceId: service.id, imageRef: point.imageRef }
      });

      return { detail: `${service.name} is pinned to the previous image.` };
    });

    logger.warn("service.rollback", {
      serviceId: service.id,
      imageRef: point.imageRef,
      outcome: health.outcome
    });

    return {
      outcome: health.outcome,
      serviceId: service.id,
      serviceName: service.name,
      containerName: service.containerName,
      rolledBackTo: point.imageRef,
      rolledBackFrom: currentImage,
      configRestored: Boolean(input.restoreConfig && point.configSnapshot),
      backupDir: backup.backupDir,
      health,
      pinNote: `${service.name} is pinned to ${point.imageRef}. Running an upgrade clears the pin and moves it forward again.`
    };
  }

  /** Best-effort restore of the image the stack was on before the rollback. */
  /**
   * Pins the compose file to an image and recreates the container on it. The
   * core of every restore, with no job context attached so an upgrade that
   * runs outside a job can use it too.
   */
  async restoreImage(settings, service, imageRef, logger) {
    await this.setComposeImage(service, imageRef);
    return this.generateAndDeploy(settings, service, { logger });
  }

  async undoPin(ctx, settings, service, previousImage, logger) {
    if (!previousImage) {
      return;
    }

    try {
      await ctx.step("restore", async () => {
        await this.restoreImage(settings, service, previousImage, logger);
        return { detail: `Restored ${service.name} to ${previousImage}.` };
      });
    } catch (error) {
      logger.error("service.rollback_restore_failed", {
        serviceId: service.id,
        message: error.message
      });
    }
  }

  /** A stack is deployable only once its compose file exists on disk. */
  async serviceIsDeployed(service) {
    try {
      await access(service.composePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The single deploy path. Save And Deploy, per-service install, and setup all
   * go through this, so the post-deploy bookkeeping cannot be applied to one
   * and missed by another.
   */
  async deployOne(settings, service, logger, { backup = false } = {}) {
    const serviceLogger = logger.child({
      serviceId: service.id,
      containerName: service.containerName
    });

    await this.prepareNetwork(settings, service, serviceLogger);

    const result = backup
      ? await this.installService(settings, service, { logger: serviceLogger })
      : await this.generateAndDeploy(settings, service, { logger: serviceLogger });

    logger[result.ok ? "info" : "error"]("service.deploy", {
      serviceId: service.id,
      serviceName: service.name,
      containerName: service.containerName,
      composePath: service.composePath,
      envPath: service.envPath,
      ok: result.ok,
      stdout: result.stdout,
      stderr: result.stderr
    });

    if (result.ok) {
      // A deploy just resolved and pulled the tag, so the service is current by
      // definition. Leaving the old status made a freshly installed app show
      // "Unknown" until someone ran a manual update check.
      await this.recordFreshImageState(service.id);
    }

    // Compose is idempotent: a service whose file has not changed is checked
    // and left alone, and it says so with "Running" rather than "Recreated".
    // Reporting that as "Deployed" made a Save And Deploy read as nine
    // deployments when it was one deployment and eight no-ops — which is how
    // an operator comes to distrust the feed, or to fear a button that is
    // safer than it looks.
    const unchanged = result.ok && !/Recreated|Created|Started/.test(`${result.stdout}\n${result.stderr}`);

    await this.appendActivity({
      kind: "deploy",
      level: result.ok ? "info" : "error",
      message: result.ok
        ? (unchanged ? `${service.name} was already up to date.` : `Deployed ${service.name}.`)
        : `Deploy failed for ${service.name}.`,
      details: {
        serviceId: service.id,
        ok: result.ok,
        unchanged,
        output: `${result.stdout}\n${result.stderr}`.trim()
      }
    });

    if (!result.ok) {
      // Surface something actionable instead of a raw Docker manifest error.
      const explanation = explainDeployFailure(`${result.stdout}\n${result.stderr}`);
      throw new KeelarrError(
        explanation
          ? `Could not deploy ${service.name}. ${explanation}`
          : `Could not deploy ${service.name}.`,
        {
          statusCode: 400,
          details: { serviceId: service.id, stdout: result.stdout, stderr: result.stderr }
        }
      );
    }

    return {
      serviceId: service.id,
      ok: result.ok,
      stdout: result.stdout,
      stderr: result.stderr,
      output: `${result.stdout}\n${result.stderr}`.trim()
    };
  }

  async deploySelected(settings, serviceIds = settings.selectedServiceIds, context = {}) {
    const logger = this.scopedLogger(context);
    const deployResults = [];

    for (const serviceId of serviceIds) {
      const service = this.requireService(settings, serviceId);

      try {
        deployResults.push(await this.deployOne(settings, service, logger));
      } catch (error) {
        // One unusable image must not stop the rest of the stack deploying.
        deployResults.push({
          serviceId,
          ok: false,
          error: error.message,
          output: error.details?.stderr || ""
        });
      }
    }

    return deployResults;
  }

  async generateServiceFiles(serviceId, context = {}) {
    const settings = await this.loadSettings();
    const service = this.requireService(settings, serviceId);
    const generated = await this.writeStacks(settings, [service.id]);
    this.scopedLogger(context).info("service.generate", {
      serviceId: service.id,
      serviceName: service.name,
      composePath: service.composePath,
      envPath: service.envPath
    });
    await this.appendActivity({
      kind: "generate",
      level: "info",
      message: `Regenerated stack files for ${service.name}.`
    });

    return {
      ok: true,
      generated
    };
  }

  async installManagedService(serviceId, context = {}) {
    // Installing an app is how you say you want it managed, so selecting it is
    // part of installing rather than a step to do first. Removal takes a
    // service out of the selection, which made "remove, then reinstall" fail
    // with "Unknown or disabled service" — and the same for any app installed
    // from the catalog without visiting Settings.
    const settings = await this.ensureSelected(serviceId, context);
    const service = this.requireService(settings, serviceId);
    await this.writeStacks(settings, [service.id]);
    // backup: an install may be replacing an existing container, so capture
    // the rollback point first.
    const result = await this.deployOne(settings, service, this.scopedLogger(context), { backup: true });

    return {
      ok: result.ok,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  /**
   * Adds a service to the selection if it is not already there, and hands back
   * settings that include it.
   *
   * Deliberately narrow: it only ever adds, and only the service being
   * installed. Nothing else about the selection is touched.
   */
  async ensureSelected(serviceId, context = {}) {
    const settings = await this.loadSettings();

    if (settings.services[serviceId]) {
      return settings;
    }

    if (!getServiceDefinition(serviceId)) {
      throw new KeelarrError(`Unknown service: ${serviceId}`, { statusCode: 404 });
    }

    if (!this.hostProfileService) {
      throw new KeelarrError(`${serviceId} is not part of this stack yet. Select it in Settings first.`, {
        statusCode: 409
      });
    }

    this.scopedLogger(context).info("service.selected", { serviceId });

    return this.hostProfileService.addSelectedService(serviceId);
  }

  async restartManagedService(serviceId, context = {}) {
    const settings = await this.loadSettings();
    const service = this.requireService(settings, serviceId);
    const logger = this.scopedLogger(context);
    const result = await this.restartService(settings, service, { logger });

    logger[result.ok ? "info" : "error"]("service.restart", {
      serviceId: service.id,
      ok: result.ok,
      stderr: result.stderr
    });

    await this.appendActivity({
      kind: "restart",
      level: result.ok ? "info" : "error",
      message: result.ok ? `Restarted ${service.name}.` : `Restart failed for ${service.name}.`
    });

    if (!result.ok) {
      throw new KeelarrError(`Could not restart ${service.name}.`, {
        statusCode: 500,
        details: { stdout: result.stdout, stderr: result.stderr }
      });
    }

    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  }

  async checkServiceUpdate(serviceId, context = {}) {
    const settings = await this.loadSettings();
    const service = this.requireService(settings, serviceId);
    const logger = this.scopedLogger(context);
    const result = await this.checkForUpdates(settings, service, {
      logger: logger.child({
        serviceId: service.id,
        containerName: service.containerName
      })
    });
    const updateState = await this.readUpdateState();

    updateState[service.id] = {
      ...(updateState[service.id] || {}),
      status: result.updateStatus,
      checkedAt: new Date().toISOString()
    };
    await this.writeUpdateState(updateState);

    logger[result.ok ? "info" : "warn"]("service.update_check", {
      serviceId: service.id,
      serviceName: service.name,
      containerName: service.containerName,
      ok: result.ok,
      updateStatus: result.updateStatus,
      stdout: result.stdout,
      stderr: result.stderr
    });

    await this.appendActivity({
      kind: "update-check",
      level: result.ok ? "info" : "warn",
      message: `Checked image update status for ${service.name}: ${result.updateStatus}.`
    });

    return {
      ok: result.ok,
      updateStatus: result.updateStatus,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  /**
   * The single upgrade path. Both the per-service button and Upgrade All go
   * through this, so they cannot drift apart again — the previous Upgrade All
   * had its own loop that never gained pin clearing or status refresh.
   */
  async upgradeOne(settings, service, logger, { verify = true, onPhase = null } = {}) {
    const serviceLogger = logger.child({
      serviceId: service.id,
      containerName: service.containerName
    });
    // A row that reads "running" for two minutes says nothing about whether
    // anything is happening. Naming the phase costs one call per stage and is
    // the difference between waiting and wondering.
    const phase = (label) => onPhase?.(label);

    if (!(await this.serviceIsDeployed(service))) {
      return { serviceId: service.id, ok: true, skipped: true, reason: "not-deployed" };
    }

    phase(`Backing up ${service.name}`);
    await this.clearRollbackPin(service, serviceLogger);
    // Read before anything moves. A revert has to prove that the backup it
    // goes back to is the image that was actually running, and after the pull
    // the container is on something else.
    const previousImageId = await this.readContainerImageId(settings, service.containerName, { logger: serviceLogger });
    phase(`Downloading the new ${service.name} image`);
    const result = await this.upgradeService(settings, service, { logger: serviceLogger });

    logger[result.ok ? "info" : "error"]("service.upgrade", {
      serviceId: service.id,
      serviceName: service.name,
      containerName: service.containerName,
      ok: result.ok,
      stdout: result.stdout,
      stderr: result.stderr
    });

    if (!result.ok && result.phase !== "up") {
      // The pull failed, so nothing changed: the old container is still
      // running and there is nothing to put back.
      await this.appendActivity({
        kind: "upgrade",
        level: "error",
        message: `Upgrade failed for ${service.name}.`,
        details: { serviceId: service.id, stdout: result.stdout, stderr: result.stderr }
      });

      return {
        serviceId: service.id,
        ok: false,
        reverted: false,
        stdout: result.stdout,
        stderr: result.stderr,
        error: (result.stderr || result.stdout || "Upgrade failed.").split("\n").filter(Boolean).pop()
      };
    }

    // Pulling and recreating is not proof the app came back. Verify the same
    // way cutover and rollback do — and verify *before* recording anything,
    // because an upgrade that is about to be reverted must never be written
    // down as current.
    phase(`Waiting for ${service.name} to come back`);
    const health = !result.ok
      ? { outcome: HEALTH_OUTCOME.FAILED, reason: "Compose could not start the new container." }
      : verify
        ? await this.verifyServiceHealth(settings, service, { ...this.verifyOptions, logger: serviceLogger })
        : null;
    const cameUp = !health || health.outcome !== HEALTH_OUTCOME.FAILED;
    const upgradedAt = new Date().toISOString();

    if (cameUp) {
      await this.recordFreshImageState(service.id, { upgradedAt });
      await this.appendActivity({
        kind: "upgrade",
        level: "info",
        message: `Upgraded ${service.name}.`,
        details: { serviceId: service.id, stdout: result.stdout, stderr: result.stderr }
      });

      return {
        serviceId: service.id,
        ok: true,
        reverted: false,
        health,
        stdout: result.stdout,
        stderr: result.stderr,
        error: null
      };
    }

    if (settings.autoRevert !== true) {
      // The new image is what is running, badly. "current" is true of the
      // image; the failure is what the activity entry and the health column
      // are for. This is the behaviour before auto-revert existed. Unless
      // Compose never started the new container: then nothing is current,
      // and the old status is kept so Upgrade All tries again.
      if (result.ok) {
        await this.recordFreshImageState(service.id, { upgradedAt });
      }
      await this.appendActivity({
        kind: "upgrade",
        level: "error",
        message: `Upgraded ${service.name}, but it did not come back healthy.`,
        details: { serviceId: service.id, reason: health.reason, stdout: result.stdout, stderr: result.stderr }
      });

      return {
        serviceId: service.id,
        ok: false,
        reverted: false,
        health,
        stdout: result.stdout,
        stderr: result.stderr,
        error: health.reason
      };
    }

    phase(`Reverting ${service.name} to the previous image`);
    const revert = await this.revertUpgrade(settings, service, previousImageId, health, serviceLogger, {
      newImageStarted: result.ok
    });
    const revertedTo = revert.taggedImage || revert.imageRef;

    return {
      serviceId: service.id,
      ok: false,
      // Restored means the container was recreated on the previous image.
      // Pinned means the compose file names it, which a failed restore can
      // also leave behind. Only the first is a revert in any useful sense.
      reverted: revert.restored === true,
      // Covers both a previous image that never came up and one that came up
      // unhealthy: neither is a recovery, which is what the nightly summary
      // separates. `running` on the result says which of the two it was.
      revertedDown: revert.restored === true && revert.ok !== true,
      pinned: revert.pinned === true,
      revertedTo: revert.imageRef || null,
      revertHealth: revert.health || null,
      health,
      stdout: result.stdout,
      stderr: result.stderr,
      // The job step and the API read this, and the activity entry says the same
      // thing in its own words a layer down. Both have to agree: a previous
      // image that is up but unhealthy must not be introduced as one that did
      // not come back, with its own reason then saying it is running.
      error: revert.ok
        ? `${health.reason} Reverted to ${revertedTo}.`
        : revert.restored
          ? revert.running
            ? `${health.reason} Reverted to ${revertedTo}, but it is still not healthy: ${revert.reason}`
            : `${health.reason} Reverted to ${revertedTo}, but that did not come back either: ${revert.reason}`
          : `${health.reason} Revert was not possible: ${revert.reason}`
    };
  }

  /**
   * Puts a service back on the image it was on before an upgrade that did not
   * come up. Runs with no job context, so both the Upgrade button and a
   * scheduled install can use it.
   *
   * The pin target is the digest from the backup, never the tag: the tag now
   * resolves to the image that just failed.
   */
  /**
   * Brings a service back up and checks that it stayed up.
   *
   * `compose up` exiting zero is not proof of a running service: a container
   * that starts and exits a second later satisfies the command and fails the
   * app, which is why the ordinary upgrade path health-checks a deploy it
   * already knows succeeded. Every recovery inside a revert needs the same
   * scepticism, because what it returns decides whether the service is
   * reported as running and its image recorded as current.
   *
   * On a short leash deliberately: this is deciding what to say about a
   * recovery, not whether to revert, and a revert is already a failure path
   * that an operator is waiting on. A container still starting when it runs
   * out is not a failure — it is on its way up.
   *
   * What it answers is whether the service is *running*, not whether it is
   * healthy. Those come apart for a container that is up with a failing
   * healthcheck, and that state is the one the refusal path already records as
   * current — the new image is what is running, badly, and the activity entry
   * carries the failure. Calling it down here would contradict that and leave
   * the same situation recorded two different ways depending on the route in.
   */
  async redeployAndConfirm(settings, service, logger) {
    const deployed = await this.generateAndDeploy(settings, service, { logger });

    if (!deployed.ok) {
      return { running: false, deployed, health: null };
    }

    try {
      const health = await this.verifyServiceHealth(settings, service, {
        ...this.verifyOptions,
        timeoutMs: this.recoveryVerifyTimeoutMs,
        startingGraceMs: 0,
        logger
      });

      return { running: health.status === "running", deployed, health };
    } catch (error) {
      logger.warn("service.recovery_verify_failed", { serviceId: service.id, message: error.message });
      return { running: false, deployed, health: null };
    }
  }

  async revertUpgrade(settings, service, previousImageId, health, logger, { newImageStarted = true } = {}) {
    // `running` says whether the new image is actually up at the point of
    // refusing. It defaults to whether it ever started, but a revert that
    // stopped the service and could not bring it back must say so: recording
    // the image as current would leave the dashboard and Upgrade All treating
    // an absent service as done.
    // The health check that sent us here recorded what the container was doing.
    // A container it found exited is not running, whatever Compose said earlier,
    // and recording its image as current would leave an absent service looking
    // done to the dashboard and to Upgrade All.
    const newImageRunning = newImageStarted && health?.status === "running";
    const refuse = async (reason, { running = newImageRunning } = {}) => {
      await this.appendActivity({
        kind: "upgrade",
        level: "error",
        message: `Upgraded ${service.name}, but it did not come back healthy, and it could not be reverted: ${reason}`,
        details: { serviceId: service.id, reason: health.reason, reverted: false, running }
      });
      // Nothing was put back, so the failed image is what is running — if it
      // ever started. When Compose could not start it, nothing is current,
      // and the old status stays so Upgrade All picks it up again.
      if (running) {
        await this.recordFreshImageState(service.id, { upgradedAt: new Date().toISOString() });
      }
      return { ok: false, pinned: false, restored: false, running, reason };
    };

    // Written by upgradeService before the pull; its imageId is the old one,
    // so it is the record findRollbackPoint returns now that the container has
    // moved on.
    const point = await this.findRollbackPoint(settings, service, { logger });

    if (!point) {
      return refuse("no rollback point was recorded.");
    }

    // findRollbackPoint skips the record matching the running image. If the
    // pull changed nothing and the container died anyway, that skip would hand
    // back an older backup than the one that was running — and reverting past
    // the previous state is the wrong thing to do silently.
    if (previousImageId && point.imageId && point.imageId !== previousImageId) {
      return refuse("the newest backup does not match the image that was running.");
    }

    if (!(await this.imageExistsLocally(settings, point.imageRef, { logger }))) {
      return refuse(`the previous image ${point.imageRef} is no longer on this host.`);
    }

    // Putting the image back is only half a revert. An app that migrates its
    // database on startup has already moved the schema forward by the time the
    // health check fails, and the older binary cannot read what the newer one
    // wrote — Trailarr parks itself on "Can't locate revision" and never binds
    // its port. So the database goes back with the image, the way a manual
    // rollback does, or the revert does not happen at all.
    //
    // Whether the app keeps state is read from the stack definition, not from
    // the live container. readConfigMountSource returns null both for a service
    // that genuinely has no /config and for an inspect that failed or found no
    // container, and reading that ambiguity as "stateless" would authorise the
    // exact image-only revert this is here to prevent. The declaration cannot
    // fail, so it decides, and the mount only ever adds to it.
    const declaresConfig = Array.isArray(service.volumes) && service.volumes.includes("config");
    // Read while the container still exists: restoring takes it down first, and
    // a container that is gone cannot be inspected for its mounts.
    //
    // An upgrade whose `compose up` never started anything leaves no container
    // to inspect, and that is exactly the failure a revert is for. The snapshot
    // recorded the mount it captured moments earlier, so that stands in when
    // the live answer is missing rather than the revert giving up.
    const recordedMount = point.configSnapshot?.mountSource
      ? { type: point.configSnapshot.mountType || "bind", source: point.configSnapshot.mountSource }
      : null;
    const configMount = (await this.readConfigMountSource(settings, service, { logger })) || recordedMount;

    if (point.configSnapshot) {
      if (!configMount) {
        return refuse("its /config mount could not be read, so the database could not be put back with the image.");
      }

      // Stop first, and only carry on if it actually stopped. The restore
      // clears /config before extracting, so letting it race a live process is
      // how a database gets torn in half — and compose down reports failure by
      // returning it, not by throwing.
      const stopped = await this.composeDown(settings, service, { logger });

      if (!stopped.ok) {
        // `down` can fail having already removed the container, so the service
        // is not necessarily still up. Put it back and report what actually
        // happened rather than assuming it never moved.
        const recovered = await this.redeployAndConfirm(settings, service, logger);
        const why = (stopped.stderr || stopped.stdout || "compose down failed.").split("\n").filter(Boolean).pop();

        return refuse(
          recovered.running
            ? `it could not be stopped, so its database was left alone rather than restored underneath a running app: ${why}`
            : `it could not be stopped (${why}), and it could not be started again afterwards. ${service.name} is down.`,
          { running: recovered.running }
        );
      }

      const restoredConfig = await this.restoreConfigSnapshot(settings, service, point.backupDir, {
        logger,
        mount: configMount,
        excludes: point.configSnapshot.excluded
      });

      if (!restoredConfig.ok) {
        // Down, with /config in an unknown state. Bring it back on the image it
        // was upgraded to — the one image that certainly matches whatever schema
        // is on disk — and say plainly when even that did not work, rather than
        // reporting a service that is down as merely left running.
        const recovered = await this.redeployAndConfirm(settings, service, logger);

        return refuse(
          recovered.running
            ? `its configuration could not be restored, so the image was left alone: ${restoredConfig.reason}`
            : `its configuration could not be restored (${restoredConfig.reason}), and it could not be started again afterwards. ${service.name} is down.`,
          { running: recovered.running }
        );
      }

      logger.info("service.revert_config_restored", {
        serviceId: service.id,
        backupDir: point.backupDir,
        backedUpAt: point.backedUpAt
      });
    } else if (declaresConfig || configMount) {
      // Stateful, with nothing to put the state back from. Going back on the
      // image alone is the move that bricks it; the new image is at least
      // consistent with its own schema, so it stays and the operator is told.
      return refuse(
        `no configuration snapshot was captured before the upgrade and ${service.name} keeps state in ${configMount?.source || "its config directory"}, so going back to ${point.imageRef} risks leaving it on a database the older version cannot read.`
      );
    }

    // setComposeImage reads, parses and writes the compose file, so this rejects
    // rather than returning on a permission or disk-space error. Unhandled, that
    // threw straight out of a revert that had already stopped the service, past
    // every recovery and every activity entry, and left it down in silence.
    let restore;

    try {
      restore = await this.restoreImage(settings, service, point.imageRef, logger);
    } catch (error) {
      logger.error("service.revert_restore_failed", { serviceId: service.id, message: error.message });
      restore = { ok: false, stdout: "", stderr: error.message };
    }

    if (!restore.ok) {
      // The compose file was already pinned to the digest. Left like that, the
      // next ordinary deploy would target a revert that never happened. If
      // the pin cannot be cleared either, say so rather than claim it was.
      let stillPinned = false;

      try {
        await this.clearRollbackPin(service, logger);
      } catch (error) {
        stillPinned = true;
        logger.error("service.revert_unpin_failed", { serviceId: service.id, message: error.message });
      }

      const deployReason = (restore.stderr || restore.stdout || "Compose could not start the previous image.").split("\n").filter(Boolean).pop();
      // The previous image would not start and the pin is off, so the compose
      // file names the tag again — the image that was just upgraded to. Nothing
      // has started it: restoring the config stopped the service, and before
      // that this path relied on the upgraded container still being there. Try
      // to bring it back, and if that fails too, say the service is down
      // instead of leaving the operator to discover it.
      const recovered = stillPinned
        ? { running: false }
        : await this.redeployAndConfirm(settings, service, logger);

      // The compose file names the tag again and the new image is up, so that
      // image is what is current. The health check deliberately skipped this
      // update on its way to a revert, and leaving the service on its old
      // "ready" would let Upgrade All start the whole sequence over at once.
      if (recovered.running) {
        await this.recordFreshImageState(service.id, { upgradedAt: new Date().toISOString() });
      }
      const reason = stillPinned
        ? `${deployReason.replace(/\.?$/, ".")} The compose file is still pinned to ${point.imageRef}.`
        : recovered.running
          ? deployReason
          : `${deployReason.replace(/\.?$/, ".")} ${service.name} could not be started again afterwards either, so it is down.`;

      await this.appendActivity({
        kind: "upgrade",
        level: "error",
        message: `Upgraded ${service.name}, but it did not come back healthy, and the revert failed too: ${reason}`,
        details: {
          serviceId: service.id,
          reason: health.reason,
          reverted: false,
          stillPinned,
          running: recovered.running,
          stderr: restore.stderr
        }
      });

      return {
        ok: false,
        pinned: stillPinned,
        restored: false,
        running: recovered.running,
        imageRef: point.imageRef,
        taggedImage: point.taggedImage,
        reason
      };
    }

    const revertHealth = await this.verifyServiceHealth(settings, service, { ...this.verifyOptions, logger });
    // Worth saying out loud in the record: an operator reading this the next
    // morning needs to know the database went back too, because that is the
    // difference between a revert and a reset to an older binary.
    const configNote = point.configSnapshot
      ? ` Its configuration from ${point.backedUpAt || "the pre-upgrade backup"} was restored with it.`
      : "";
    // The pin is in place whatever the previous image does next, and it is
    // what keeps the nightly run away, so the state is rolled-back either way.
    await this.recordRolledBackState(service.id);
    const revertedTo = point.taggedImage || point.imageRef;

    if (revertHealth.outcome === HEALTH_OUTCOME.FAILED) {
      // Going back did not bring it back healthy — a migration the new image ran
      // on the database, most likely. Calling that "reverted" and returning ok
      // would report a service that is not working as recovered.
      //
      // Down and up-but-unhealthy are different things, though, and the record
      // has to say which: "did not come back either" of a container that is
      // running is simply wrong, and it is the sentence an operator reads first.
      // Both still count as a failed revert rather than a recovery — an app on
      // its old image with a failing healthcheck is not fixed — but only one of
      // them is off.
      const revertRunning = revertHealth.status === "running";
      const message = revertRunning
        ? `Upgraded ${service.name}, but it did not come back healthy. Reverted to ${revertedTo}, which is running but still not healthy.${configNote}`
        : `Upgraded ${service.name}, but it did not come back healthy. Reverted to ${revertedTo}, but that did not come back either.${configNote}`;

      await this.appendActivity({
        kind: "upgrade",
        level: "error",
        message,
        details: {
          serviceId: service.id,
          reason: health.reason,
          reverted: true,
          revertedTo: point.imageRef,
          running: revertRunning,
          revertHealth: revertHealth.outcome,
          revertReason: revertHealth.reason
        }
      });
      logger.error("service.upgrade_revert_down", {
        serviceId: service.id,
        to: point.imageRef,
        running: revertRunning,
        reason: revertHealth.reason
      });

      return {
        ok: false,
        pinned: true,
        restored: true,
        running: revertRunning,
        configRestored: Boolean(point.configSnapshot),
        imageRef: point.imageRef,
        taggedImage: point.taggedImage,
        health: revertHealth,
        reason: revertRunning
          ? `${revertHealth.reason} It is running, but not healthy.`
          : revertHealth.reason
      };
    }

    await this.appendActivity({
      kind: "upgrade",
      level: "error",
      message: `Upgraded ${service.name}, but it did not come back healthy. Reverted to ${revertedTo}.${configNote}`,
      details: {
        serviceId: service.id,
        reason: health.reason,
        reverted: true,
        revertedTo: point.imageRef,
        running: true,
        revertHealth: revertHealth.outcome
      }
    });
    logger.warn("service.upgrade_reverted", {
      serviceId: service.id,
      to: point.imageRef,
      reason: health.reason,
      revertHealth: revertHealth.outcome
    });

    return {
      ok: true,
      pinned: true,
      restored: true,
      configRestored: Boolean(point.configSnapshot),
      imageRef: point.imageRef,
      taggedImage: point.taggedImage,
      health: revertHealth
    };
  }

  async upgradeManagedService(serviceId, context = {}) {
    const settings = await this.loadSettings();
    const service = this.requireService(settings, serviceId);
    const result = await this.upgradeOne(settings, service, this.scopedLogger(context));

    return {
      ok: result.ok,
      skipped: result.skipped === true,
      health: result.health || null,
      reverted: result.reverted === true,
      revertedTo: result.revertedTo || null,
      error: result.error || null,
      stdout: result.stdout || "",
      stderr: result.stderr || ""
    };
  }

  async checkAllUpdates(context = {}, { serviceIds = null } = {}) {
    const settings = await this.loadSettings();
    const nextState = await this.readUpdateState();
    const results = [];
    const logger = this.scopedLogger(context);
    // A scheduled install checks only the apps that opted in, so the window
    // pulls their images and not the whole stack's.
    const wanted = Array.isArray(serviceIds) ? new Set(serviceIds) : null;

    for (const serviceId of settings.selectedServiceIds) {
      if (wanted && !wanted.has(serviceId)) {
        continue;
      }

      const service = this.requireService(settings, serviceId);

      // A service that was never deployed has no compose file to pull against.
      // Reporting that as a failure makes a healthy stack look broken.
      if (!(await this.serviceIsDeployed(service))) {
        results.push({
          serviceId: service.id,
          ok: true,
          skipped: true,
          updateStatus: "not-deployed"
        });
        continue;
      }

      const result = await this.checkForUpdates(settings, service, {
        logger: logger.child({
          serviceId: service.id,
          containerName: service.containerName
        })
      });
      nextState[service.id] = {
        ...(nextState[service.id] || {}),
        status: result.updateStatus,
        checkedAt: new Date().toISOString()
      };
      results.push({
        serviceId: service.id,
        ok: result.ok,
        updateStatus: result.updateStatus,
        // A stalled pull is diagnosed by the command runner; its stderr is
        // just the last progress line. The diagnosis comes first.
        error: result.ok ? null : result.error || (result.stderr || result.stdout || "").split("\n").filter(Boolean).pop() || null
      });
    }

    await this.writeUpdateState(nextState);
    logger.info("service.update_check_all", {
      results
    });
    await this.appendActivity({
      kind: "update-check-all",
      level: "info",
      message: "Checked update status across the selected stack."
    });

    return {
      ok: true,
      results
    };
  }

  /**
   * Decides what an Upgrade All would actually do, from what is already known.
   *
   * Checking is a `compose pull`, so re-checking during an upgrade would
   * download every image in the stack to learn what the last check already
   * recorded. The stored state decides instead, and a service is only touched
   * when it is known to need it — which also means the job's steps are the
   * work, not a roll-call of the whole stack.
   */
  planUpgradeAll(services, updateState, { force = false } = {}) {
    const upgradable = [];
    const current = [];
    const unchecked = [];

    for (const service of services) {
      const status = updateState[service.id]?.status;

      if (force || status === "ready") {
        upgradable.push(service);
        continue;
      }

      if (status === "current" || status === "not-deployed") {
        current.push(service);
        continue;
      }

      // Never checked, or checked and unreadable. Upgrading anyway is how
      // Trailarr ended up in a run nobody asked for; the honest move is to say
      // its state is unknown and let the operator decide.
      unchecked.push(service);
    }

    return { upgradable, current, unchecked };
  }

  startUpgradeAll(input = {}, context = {}) {
    return {
      create: async () => {
        const settings = await this.loadSettings();
        const services = settings.selectedServiceIds.map((serviceId) => this.requireService(settings, serviceId));
        const updateState = await this.readUpdateState();
        const plan = this.planUpgradeAll(services, updateState, { force: input?.force === true });

        if (plan.upgradable.length === 0) {
          // No job at all rather than a job of nothing: a progress panel that
          // exists only to report that nothing happened is noise.
          return {
            ok: true,
            job: null,
            upgraded: 0,
            skipped: plan.current.length,
            unchecked: plan.unchecked.map((service) => service.id),
            message: plan.unchecked.length
              ? `Everything with a known update is already current. ${plan.unchecked
                .map((service) => service.name)
                .join(", ")} could not be checked, so ${plan.unchecked.length === 1 ? "its" : "their"} state is unknown.`
              : "Everything is already up to date."
          };
        }

        const job = this.requireJobs().create({
          kind: "upgrade-all",
          subject: { serviceId: "*" },
          steps: plan.upgradable.map((service) => ({ name: service.id, label: `Upgrade ${service.name}` }))
        });

        return this.jobs.start(job, (ctx) => this.runUpgradeAll(ctx, settings, plan, context, input));
      }
    };
  }

  /**
   * Upgrades each service as its own job step. One bad service must not strand
   * the rest half-upgraded, so a failure is recorded and the loop goes on.
   * Shared by Upgrade All and by scheduled installs.
   */
  async upgradeAsSteps(ctx, settings, services, logger, { keepAlive = null } = {}) {
    const results = [];

    for (const service of services) {
      keepAlive?.();

      try {
        const result = await ctx.step(service.id, async () => {
          const outcome = await this.upgradeOne(settings, service, logger, {
            onPhase: (label) => {
              keepAlive?.();
              ctx.note(service.id, label);
            }
          });

          if (!outcome.ok) {
            throw new KeelarrError(outcome.error || `Upgrade failed for ${service.name}.`, {
              statusCode: 500,
              details: {
                reverted: outcome.reverted === true,
                revertedDown: outcome.revertedDown === true,
                revertedTo: outcome.revertedTo || null
              }
            });
          }

          return {
            detail: outcome.skipped
              ? "Not installed, skipped."
              : outcome.health
                ? outcome.health.reason
                : "Upgraded.",
            ...outcome
          };
        });
        results.push(result);
      } catch (error) {
        results.push({
          serviceId: service.id,
          ok: false,
          error: error.message,
          reverted: error.details?.reverted === true,
          revertedDown: error.details?.revertedDown === true
        });
      }
    }

    return results;
  }

  async runUpgradeAll(ctx, settings, plan, context, input = {}) {
    const logger = this.scopedLogger(context);
    // Only what the plan selected. Services already known to be current are not
    // steps at all, so the panel shows the work rather than the whole stack.
    const results = await this.upgradeAsSteps(ctx, settings, plan.upgradable, logger);

    const failed = results.filter((result) => !result.ok);
    const upgraded = results.filter((result) => result.ok && !result.skipped);
    const skipped = results.filter((result) => result.skipped);
    const services = plan.upgradable;

    await this.appendActivity({
      kind: "upgrade-all",
      level: failed.length ? "error" : "info",
      message: failed.length
        ? `Upgraded ${upgraded.length} of ${services.length} services; ${failed.length} failed.`
        : `Upgraded the selected stack (${upgraded.length} services).`,
      details: results
    });

    logger[failed.length ? "error" : "info"]("service.upgrade_all", {
      upgraded: upgraded.length,
      skipped: skipped.length,
      failed: failed.length
    });

    // Counted from the plan rather than from the steps, because services that
    // were already current never became steps — reporting only what ran would
    // lose the fact that the rest were considered and deliberately left alone.
    const untouched = plan.current.length;

    return {
      upgraded: upgraded.length,
      skipped: skipped.length + untouched,
      failed: failed.length,
      total: services.length,
      unchecked: plan.unchecked.map((service) => service.id),
      results,
      summary: [
        failed.length
          ? `${upgraded.length} upgraded, ${failed.length} failed`
          : `${upgraded.length} upgraded`,
        untouched ? `${untouched} already current` : null,
        plan.unchecked.length
          ? `${plan.unchecked.length} could not be checked`
          : null
      ].filter(Boolean).join(", ") + "."
    };
  }
}
