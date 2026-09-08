import { randomUUID } from "node:crypto";
import { chmod, copyFile, readFile, stat, unlink, writeFile } from "node:fs/promises";

import { APP_VERSION } from "../app-meta.js";
import { DATA_MOUNT, DEPLOY_MOUNT, DOCKER_SOCKET_MOUNT, findMount, readEnvValue } from "../host-mounts.js";
import {
  appendActivity,
  readControllerUpdateState,
  readSelfUpdateReceipt,
  writeControllerUpdateState,
  writeSelfUpdateReceipt
} from "../store.js";
import { selfUpdateAckPath } from "../data-paths.js";
import {
  pullImage,
  readContainerImageIdByName,
  readContainerLogs,
  readContainerOutcome,
  readImageId,
  removeContainer,
  runDetachedContainer,
  tagImage
} from "../runtime.js";
import { KeelarrError } from "../errors.js";
import { defaultLogger } from "../logger.js";
import { HELPER_SCRIPT } from "./self-update-helper.js";

const RELEASES_URL = "https://api.github.com/repos/tx-joshg/keelarr/releases/latest";
const PUBLISHED_IMAGE_PREFIX = "ghcr.io/tx-joshg/keelarr";
// Long enough that a dead network cannot stall a dashboard render, short enough
// that a slow answer is still worth waiting for.
const RELEASE_TIMEOUT_MS = 8_000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// A local tag, re-pointed on every update, so rollback has a concrete target.
// compose.example.yml interpolates a tag, so a digest cannot be pinned through
// it, and "the previous version" may have had no tag of its own.
const ROLLBACK_TAG = `${PUBLISHED_IMAGE_PREFIX}:keelarr-rollback`;
const HELPER_PREFIX = "keelarr-self-update-";
// Each verification window the helper may run, in seconds: one for the target,
// one more if it has to roll back.
const HEALTH_TIMEOUT_S = 180;

export const SELF_UPDATE_STEPS = Object.freeze([
  { name: "preflight", label: "Check that Keelarr can update itself" },
  { name: "pull", label: "Download the new Keelarr image" },
  { name: "verify-image", label: "Check the new image runs on this host" },
  { name: "mark-rollback", label: "Tag the current image for rollback" },
  { name: "pin", label: "Point deploy/.env at the new version" },
  { name: "handoff", label: "Start the updater and step aside" }
]);

/**
 * Strips a leading v so a git tag and a package version can be compared.
 * `readImageVersionLabel` does the same thing for app images.
 */
export function normalizeVersion(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

/**
 * Compares two dotted versions numerically, so 0.1.10 sorts above 0.1.9.
 *
 * A string compare gets that backwards, and getting it backwards means telling
 * someone they are up to date when they are nine releases behind.
 */
export function compareVersions(left, right) {
  const parse = (value) => normalizeVersion(value).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);

    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }

  return 0;
}

/**
 * Reports whether Keelarr can replace its own container on this host, and what
 * the newest published release is.
 *
 * Deliberately separate from ManagedStackService: that class is built around
 * `settings.services[serviceId]` — per-service backups, config snapshots,
 * rollback points — and the controller has none of those. Folding this in would
 * put an "unless it is the controller" branch through half of it.
 */
export class SelfUpdateService {
  constructor({
    hostProfileService = null,
    jobs = null,
    logger = defaultLogger,
    fetchImpl = globalThis.fetch,
    readControllerUpdateStateImpl = readControllerUpdateState,
    writeControllerUpdateStateImpl = writeControllerUpdateState,
    nowImpl = () => Date.now(),
    appVersion = APP_VERSION,
    releasesUrl = RELEASES_URL,
    lease = null,
    pullImageImpl = pullImage,
    readImageIdImpl = readImageId,
    readContainerImageIdImpl = readContainerImageIdByName,
    tagImageImpl = tagImage,
    runDetachedContainerImpl = runDetachedContainer,
    runImageProbeImpl = null,
    readContainerOutcomeImpl = readContainerOutcome,
    readContainerLogsImpl = readContainerLogs,
    removeContainerImpl = removeContainer,
    readReceiptImpl = readSelfUpdateReceipt,
    writeReceiptImpl = writeSelfUpdateReceipt,
    readFileImpl = readFile,
    writeFileImpl = writeFile,
    copyFileImpl = copyFile,
    statImpl = stat,
    unlinkImpl = unlink,
    chmodImpl = chmod,
    ackPathImpl = selfUpdateAckPath,
    createOperationId = () => randomUUID().slice(0, 12),
    appendActivityImpl = appendActivity
  } = {}) {
    this.hostProfileService = hostProfileService;
    this.jobs = jobs;
    this.logger = logger;
    this.fetch = fetchImpl;
    this.readControllerUpdateState = readControllerUpdateStateImpl;
    this.writeControllerUpdateState = writeControllerUpdateStateImpl;
    this.now = nowImpl;
    this.appVersion = appVersion;
    this.releasesUrl = releasesUrl;
    this.lease = lease;
    this.pullImage = pullImageImpl;
    this.readImageId = readImageIdImpl;
    this.readContainerImageId = readContainerImageIdImpl;
    this.tagImage = tagImageImpl;
    this.runDetachedContainer = runDetachedContainerImpl;
    this.runImageProbe = runImageProbeImpl;
    this.readContainerOutcome = readContainerOutcomeImpl;
    this.readContainerLogs = readContainerLogsImpl;
    this.removeContainer = removeContainerImpl;
    this.readReceipt = readReceiptImpl;
    this.writeReceipt = writeReceiptImpl;
    this.readFile = readFileImpl;
    this.writeFile = writeFileImpl;
    this.copyFile = copyFileImpl;
    this.stat = statImpl;
    this.unlink = unlinkImpl;
    this.chmod = chmodImpl;
    this.ackPath = ackPathImpl;
    this.createOperationId = createOperationId;
    this.appendActivity = appendActivityImpl;
  }

  scopedLogger(context = {}) {
    return context.requestId ? this.logger.child({ requestId: context.requestId }) : this.logger;
  }

  /**
   * Every reason the controller could not replace itself, each carrying its own
   * message so the UI prints what was actually found rather than mapping ids to
   * a second copy of these sentences.
   */
  buildChecks(controller, { jobRunning = false } = {}) {
    const mounts = controller?.mounts || [];
    const image = controller?.image || "";
    const configFiles = controller?.configFiles || [];

    return [
      {
        id: "container",
        label: "Keelarr can see its own container",
        ok: Boolean(controller?.containerName),
        reason: "Keelarr cannot see its own container, so it cannot replace it."
      },
      {
        id: "socket",
        label: "The Docker socket is mounted",
        ok: Boolean(findMount(mounts, DOCKER_SOCKET_MOUNT)),
        reason: "The Docker socket is not mounted into Keelarr."
      },
      {
        id: "compose",
        label: "The container was created by Compose",
        ok: Boolean(controller?.projectName) && configFiles.length > 0,
        reason: "Keelarr's container was not created by Docker Compose, so there is no project to recreate it from."
      },
      {
        id: "service-label",
        label: "Compose recorded which service this is",
        ok: Boolean(controller?.serviceName),
        reason: "Compose did not record which service Keelarr is, so a recreate could act on the wrong one."
      },
      {
        id: "deploy-mount",
        label: "The deploy directory is mounted",
        ok: Boolean(findMount(mounts, DEPLOY_MOUNT)),
        reason: `The deploy directory is not mounted. Add ./:${DEPLOY_MOUNT} and recreate the controller.`
      },
      {
        id: "data-mount",
        label: "The data directory is mounted",
        ok: Boolean(findMount(mounts, DATA_MOUNT)),
        reason: "The data directory is not mounted, so the result of an update could not survive the restart."
      },
      {
        id: "published-image",
        label: "Running a published image",
        ok: image.startsWith(PUBLISHED_IMAGE_PREFIX),
        reason: image
          ? `Keelarr is running ${image}, which is not a published image. Self-update only applies to images from ${PUBLISHED_IMAGE_PREFIX}.`
          : "Keelarr could not read its own image reference."
      },
      {
        id: "idle",
        label: "Nothing else is running",
        ok: !jobRunning,
        reason: "Another operation is running. Restarting Keelarr in the middle of it would leave that half-finished."
      }
    ];
  }

  /**
   * Cheap enough for every dashboard render: one container inspect and one file
   * read, and never a network call. Discovery happens in checkSelfUpdate.
   */
  async describeSelfUpdate(context = {}) {
    const logger = this.scopedLogger(context);
    const settings = await this.hostProfileService.loadSettings();
    let controller = null;

    try {
      controller = await this.hostProfileService.readControllerDefinition(settings, logger);
    } catch (error) {
      logger.warn("self_update.controller_unreadable", { error: error.message });
    }

    // This feature's own job does not count as something it has to wait for:
    // it is the operation asking. Two updates at once are prevented by the
    // lease, which is a stronger guarantee than a status scan.
    const jobRunning = Boolean(
      this.jobs?.list().some(
        (job) => job.kind !== "controller-update" && (job.status === "running" || job.status === "pending")
      )
    );
    const checks = this.buildChecks(controller, { jobRunning });
    const blocked = checks.find((check) => !check.ok) || null;
    const state = await this.readControllerUpdateState();
    const receipt = await this.readReceipt().catch(() => null);
    const currentVersion = normalizeVersion(this.appVersion);
    const targetVersion = normalizeVersion(state.latestVersion);
    const behind = targetVersion ? compareVersions(currentVersion, targetVersion) < 0 : false;

    return {
      currentVersion,
      targetVersion: targetVersion || null,
      // "current" is only claimed when a check actually said so.
      updateStatus: state.checkedAt ? (behind ? "ready" : "current") : "unchecked",
      checkedAt: state.checkedAt || null,
      checkError: state.error || null,
      supported: !blocked,
      available: Boolean(behind) && !blocked,
      reason: blocked?.reason || null,
      checks,
      inFlight: receipt && receipt.status === "handed-off"
        ? { operationId: receipt.operationId, targetVersion: receipt.targetVersion, startedAt: receipt.startedAt }
        : null,
      // Reported until it is dismissed, because the update's own job died with
      // the container that started it and this is the only account of it.
      lastResult: receipt && receipt.status !== "handed-off" && receipt.acknowledged !== true
        ? {
            operationId: receipt.operationId,
            outcome: receipt.status,
            targetVersion: receipt.targetVersion,
            previousVersion: receipt.previousVersion,
            detail: receipt.detail || null,
            finishedAt: receipt.finishedAt || null
          }
        : null,
      recoveryCommand: this.buildRecoveryCommand(controller, settings)
    };
  }

  /**
   * Asks GitHub for the newest release. Nothing is downloaded.
   *
   * The release tag, not the `latest` image tag: deploy/.env pins an exact
   * version and renderControllerEnv carries that pin across every settings
   * save, so discovery has to produce a version number rather than move the
   * install onto a floating tag.
   */
  async checkSelfUpdate(context = {}) {
    const logger = this.scopedLogger(context);
    const state = await this.readControllerUpdateState();
    let next;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RELEASE_TIMEOUT_MS);
      let response;

      try {
        response = await this.fetch(this.releasesUrl, {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "keelarr" },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw new Error(`GitHub answered ${response.status}.`);
      }

      const body = await response.json();
      const latestVersion = normalizeVersion(body?.tag_name);

      if (!latestVersion) {
        throw new Error("The newest release has no version tag.");
      }

      next = {
        ...state,
        latestVersion,
        releaseUrl: body?.html_url || null,
        checkedAt: new Date(this.now()).toISOString(),
        error: null
      };
      logger.info("self_update.checked", { latestVersion, currentVersion: normalizeVersion(this.appVersion) });
    } catch (error) {
      // A failed check must not read as "up to date". The previous answer is
      // kept, the failure is recorded beside it, and the UI says which it is.
      next = {
        ...state,
        checkedAt: state.checkedAt || null,
        error: error.name === "AbortError" ? "GitHub did not answer in time." : error.message
      };
      logger.warn("self_update.check_failed", { error: next.error });
    }

    await this.writeControllerUpdateState(next);
    return this.describeSelfUpdate(context);
  }

  /**
   * The command that puts this controller back, built from the identity Compose
   * recorded rather than a path guessed by the UI.
   *
   * Handed over before the risk is taken, because if Keelarr does not come back
   * neither does the page that would have shown it.
   */
  buildRecoveryCommand(controller, settings = {}) {
    if (!controller?.projectName || !(controller.configFiles || []).length) {
      return null;
    }

    const files = controller.configFiles.map((file) => `-f ${file}`).join(" ");
    // The operator's own binary where one is configured. Keelarr runs `docker`
    // from inside its container, where it is on the path; the host it is typed
    // on may be a NAS where it is not, and a safety net that does not run is
    // worse than none.
    const docker = settings.dockerBin || "docker";
    const directory = controller.workingDir || ".";

    return `cd ${directory} && KEELARR_VERSION=${normalizeVersion(this.appVersion)} ${docker} compose -p ${controller.projectName} ${files} --env-file ${directory}/.env up -d ${controller.serviceName || "keelarr"}`;
  }

  /** The absolute paths this update touches, resolved from the container's own mounts. */
  resolvePaths(controller) {
    const deploy = findMount(controller?.mounts || [], DEPLOY_MOUNT);
    const socket = findMount(controller?.mounts || [], DOCKER_SOCKET_MOUNT);
    const data = findMount(controller?.mounts || [], DATA_MOUNT);

    return {
      // The host path, mounted into the helper at the same path it has here.
      // compose.example.yml uses relative bind sources (./ and ../data), which
      // the daemon resolves on the host — so a helper that mounted this
      // anywhere else would recreate Keelarr with its data directory pointing
      // at a path that does not exist, which Docker silently creates empty.
      hostDeployDir: deploy?.source || null,
      socketSource: socket?.source || null,
      dataSource: data?.source || null,
      envPath: `${DEPLOY_MOUNT}/.env`,
      envBackupPath: `${DEPLOY_MOUNT}/.env.keelarr-backup`,
      hostEnvPath: deploy ? `${deploy.source}/.env` : null,
      hostEnvBackupPath: deploy ? `${deploy.source}/.env.keelarr-backup` : null
    };
  }

  /** The argv the helper replays, carrying the whole project identity. */
  buildComposeFileArgs(controller) {
    return (controller.configFiles || []).flatMap((file) => ["-f", file]);
  }

  /**
   * Replaces one key in an env file, leaving every other byte alone.
   *
   * Not renderControllerEnv: that rewrites the whole file from settings, which
   * is right on save and wrong mid-update — it would drop anything the operator
   * had added and rewrite values this operation has no opinion about.
   */
  setEnvValue(text, key, value) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, "m");

    if (pattern.test(text)) {
      // Only the first assignment is replaced; Compose reads the last one, so a
      // duplicated key is repaired by dropping the rest rather than leaving a
      // stale value to win.
      const once = text.replace(pattern, line);
      return once.replace(new RegExp(`(^${line}$[\\s\\S]*?)^[ \\t]*${key}[ \\t]*=.*$\\n?`, "gm"), "$1");
    }

    const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";

    return `${text}${separator}${line}\n`;
  }

  startSelfUpdate(input = {}, context = {}) {
    const job = this.jobs.create({
      kind: "controller-update",
      subject: { serviceId: "keelarr" },
      steps: SELF_UPDATE_STEPS.map((step) => ({ ...step }))
    });

    return this.jobs.start(job, (ctx) => this.runSelfUpdate(ctx, job, input, context));
  }

  async runSelfUpdate(ctx, job, input = {}, context = {}) {
    const logger = this.scopedLogger(context);
    const settings = await this.hostProfileService.loadSettings();
    const operationId = this.createOperationId();
    let controller = null;
    let paths = null;
    let originalEnv = null;
    let targetVersion = null;

    await ctx.step("preflight", async () => {
      // Re-checked inside the lease: eligibility can move between the GET that
      // drew the button and the POST that pressed it.
      this.lease?.acquire({
        reason: "A Keelarr update",
        operationId,
        detail: "Keelarr is about to restart, and this would be left half-finished."
      });

      controller = await this.hostProfileService.readControllerDefinition(settings, logger);
      const described = await this.describeSelfUpdate(context);
      const blocked = described.checks.find((check) => !check.ok);

      if (blocked) {
        throw new KeelarrError(blocked.reason, { statusCode: 409, details: { check: blocked.id } });
      }

      targetVersion = normalizeVersion(input.version || described.targetVersion);

      if (!targetVersion) {
        throw new KeelarrError("No newer release has been found. Check for an update first.", { statusCode: 409 });
      }

      if (compareVersions(normalizeVersion(this.appVersion), targetVersion) >= 0) {
        throw new KeelarrError(`Keelarr is already running ${this.appVersion}.`, { statusCode: 409 });
      }

      paths = this.resolvePaths(controller);

      // A stopped helper from a previous update is kept for diagnosis, so it is
      // cleared here rather than by the reconciliation that found it — at that
      // point it is still the rollback watchdog.
      await this.removeContainer(settings, `${HELPER_PREFIX}${operationId}`, { logger }).catch(() => {});
    });

    const targetImage = `${PUBLISHED_IMAGE_PREFIX}:${targetVersion}`;

    await ctx.step("pull", async () => {
      // Pulled while Keelarr is still alive and can report a failure. Doing it
      // inside the handoff would mean a network problem stranded the update at
      // the one point where nothing can say so.
      const result = await this.pullImage(settings, targetImage, { logger });

      if (result.ok === false) {
        throw new KeelarrError(`Could not download ${targetImage}.`, {
          statusCode: 502,
          details: { stderr: result.stderr }
        });
      }
    });

    const targetImageId = await this.readImageId(settings, targetImage, { logger });

    await ctx.step("verify-image", async () => {
      if (!targetImageId) {
        throw new KeelarrError(`${targetImage} is not on this host after the pull.`, { statusCode: 502 });
      }

      if (!this.runImageProbe) {
        return;
      }

      // Proves the new image runs on this architecture while there is still
      // something able to say it does not.
      const probe = await this.runImageProbe(settings, targetImage, { logger });

      if (probe.ok === false) {
        throw new KeelarrError(`${targetImage} did not run on this host.`, {
          statusCode: 422,
          details: { stderr: probe.stderr }
        });
      }
    });

    await ctx.step("mark-rollback", async () => {
      await this.tagImage(settings, controller.imageId, ROLLBACK_TAG, { logger });
    });

    await ctx.step("pin", async () => {
      originalEnv = await this.readFile(paths.envPath, "utf8");
      await this.copyFile(paths.envPath, paths.envBackupPath);

      try {
        const mode = (await this.stat(paths.envPath)).mode & 0o777;
        await this.chmod(paths.envBackupPath, mode);
      } catch {
        // Best effort: a backup with default permissions still restores the
        // bytes, which is what matters.
      }

      await this.writeFile(paths.envPath, this.setEnvValue(originalEnv, "KEELARR_VERSION", targetVersion), "utf8");
    });

    const helperName = `${HELPER_PREFIX}${operationId}`;

    try {
      await ctx.step("handoff", async () => {
        const receipt = {
          schema: 1,
          operationId,
          jobId: job.id,
          status: "handed-off",
          startedAt: new Date(this.now()).toISOString(),
          finishedAt: null,
          containerName: controller.containerName,
          helperContainer: helperName,
          previousVersion: normalizeVersion(this.appVersion),
          previousImageId: controller.imageId,
          targetVersion,
          targetImage,
          targetImageId,
          rollbackTag: ROLLBACK_TAG,
          healthTimeoutSeconds: HEALTH_TIMEOUT_S,
          acknowledged: false,
          detail: null
        };

        await this.writeReceipt(receipt);

        const result = await this.runDetachedContainer(settings, {
          name: helperName,
          // It drives the daemon over the socket and waits on a file, so it
          // needs no network at all.
          network: "none",
          image: controller.imageId,
          entrypoint: "/bin/sh",
          command: ["-c", HELPER_SCRIPT],
          workingDir: paths.hostDeployDir,
          labels: { "io.keelarr.role": "self-update", "io.keelarr.operation": operationId },
          mounts: [
            { source: paths.socketSource, target: DOCKER_SOCKET_MOUNT },
            // Same path on both sides. See resolvePaths.
            { source: paths.hostDeployDir, target: paths.hostDeployDir },
            { source: paths.dataSource, target: DATA_MOUNT }
          ],
          environment: {
            SU_PROJECT: controller.projectName,
            SU_SERVICE: controller.serviceName,
            SU_FILE_ARGS: this.buildComposeFileArgs(controller).join(" "),
            SU_PROJECT_DIR: controller.workingDir || paths.hostDeployDir,
            SU_ENV_FILE: paths.hostEnvPath,
            SU_ENV_BACKUP: paths.hostEnvBackupPath,
            SU_CONTAINER: controller.containerName,
            SU_TARGET_IMAGE_ID: targetImageId,
            SU_ROLLBACK_VERSION: "keelarr-rollback",
            SU_ACK_TARGET: `${DATA_MOUNT}/self-update-ack-${operationId}`,
            SU_ACK_ROLLBACK: `${DATA_MOUNT}/self-update-ack-${operationId}-rollback`,
            SU_LOG: `${DATA_MOUNT}/self-update.log`,
            SU_HEALTH_TIMEOUT: String(HEALTH_TIMEOUT_S),
            SU_SETTLE: "5"
          }
        }, { logger });

        if (result.ok === false) {
          throw new KeelarrError("The updater container could not be started.", {
            statusCode: 500,
            details: { stderr: result.stderr }
          });
        }
      });
    } catch (error) {
      await this.abandon(settings, { paths, originalEnv, operationId, helperName, logger, reason: error.message });
      throw error;
    }

    logger.info("self_update.handed_off", { operationId, targetVersion, helperName });

    // Never resolves. The controller is about to be stopped, and a handler that
    // returned would have this job recorded as succeeded before the work began.
    return this.jobs.markHandedOff(job, { operationId, detail: `Updating to ${targetVersion}.` });
  }

  /** Undoes a half-started update while there is still a controller to do it. */
  async abandon(settings, { paths, originalEnv, operationId, helperName, logger, reason }) {
    if (paths && originalEnv !== null && originalEnv !== undefined) {
      await this.writeFile(paths.envPath, originalEnv, "utf8").catch(() => {});
    }

    if (helperName) {
      await this.removeContainer(settings, helperName, { logger }).catch(() => {});
    }

    await this.writeReceipt({
      schema: 1,
      operationId,
      status: "failed",
      finishedAt: new Date(this.now()).toISOString(),
      acknowledged: true,
      detail: reason
    }).catch(() => {});

    this.lease?.release(operationId);
  }

  /**
   * Works out what happened to an update that outlived the controller that
   * started it, and finishes the record.
   *
   * The outcome is derived from the running container rather than from the
   * helper's word: the helper can still be deciding, and a controller that has
   * just come up is the only thing that can say for certain which image it is.
   *
   * Runs on every start, so the no-receipt path costs nothing.
   */
  async reconcile(context = {}) {
    const logger = this.scopedLogger(context);
    let receipt = null;

    try {
      receipt = await this.readReceipt();
    } catch {
      return null;
    }

    if (!receipt || !receipt.operationId) {
      return null;
    }

    // A finished receipt that has already been reported stays finished. Left to
    // re-derive on every boot it would eventually reinterpret an ordinary
    // manual version change as the outcome of an update from weeks ago.
    if (receipt.acknowledged === true) {
      return null;
    }

    const settings = await this.hostProfileService.loadSettings();
    const runningImageId = await this.readContainerImageId(settings, receipt.containerName, { logger });
    const helper = receipt.helperContainer
      ? await this.readContainerOutcome(settings, receipt.helperContainer, { logger })
      : { exists: false, status: null, exitCode: null };

    let status = "unknown";
    let detail = null;

    if (runningImageId && runningImageId === receipt.targetImageId) {
      status = "succeeded";
      detail = `Updated to ${receipt.targetVersion}.`;
    } else if (runningImageId && runningImageId === receipt.previousImageId) {
      status = "rolled-back";
      detail = helper.exitCode === 11
        ? `${receipt.targetVersion} did not come up, and neither did the version restored in its place.`
        : `${receipt.targetVersion} did not come up. Keelarr was put back on ${receipt.previousVersion}.`;
    } else if (helper.status === "running") {
      // The helper is still deciding. Leave the receipt open so the next start
      // finishes it, rather than guessing now.
      logger.info("self_update.reconcile_pending", { operationId: receipt.operationId });
      return { ...receipt, status: "handed-off" };
    } else {
      detail = await this.readContainerLogs(settings, receipt.helperContainer, { tail: 20, logger });
    }

    const finished = {
      ...receipt,
      status,
      finishedAt: new Date(this.now()).toISOString(),
      acknowledged: false,
      detail
    };

    await this.writeReceipt(finished);

    await this.jobs?.finalizeHandedOff(receipt.operationId, {
      status: status === "succeeded" ? "succeeded" : "failed",
      result: { outcome: status, targetVersion: receipt.targetVersion, previousVersion: receipt.previousVersion },
      error: status === "succeeded" ? null : { message: detail || "The update did not complete.", details: { outcome: status } },
      steps: { handoff: { status: status === "succeeded" ? "succeeded" : "failed", detail } }
    }).catch((error) => logger.warn("self_update.finalize_failed", { error: error.message }));

    await this.appendActivity({
      kind: "self-update",
      level: status === "succeeded" ? "info" : "warn",
      message: detail || `Keelarr update finished as ${status}.`
    }).catch(() => {});

    if (status === "succeeded") {
      await this.writeControllerUpdateState({
        ...(await this.readControllerUpdateState()),
        checkedAt: new Date(this.now()).toISOString(),
        error: null
      }).catch(() => {});
    }

    this.lease?.release(receipt.operationId);

    // Written last, and only once everything above has settled: the helper is
    // waiting on this file to decide whether the update took. Docker health
    // would have gone green before any of this ran.
    const ackPath = status === "rolled-back"
      ? this.ackPath(`${receipt.operationId}-rollback`)
      : this.ackPath(receipt.operationId);

    await this.writeFile(ackPath, `${status}\n`, "utf8").catch((error) =>
      logger.warn("self_update.ack_failed", { error: error.message })
    );

    logger.info("self_update.reconciled", { operationId: receipt.operationId, status });

    return finished;
  }

  /** Marks the last outcome as seen, so it stops being reported. */
  async dismissNotice() {
    const receipt = await this.readReceipt();

    if (!receipt) {
      return { ok: true };
    }

    await this.writeReceipt({ ...receipt, acknowledged: true });

    return { ok: true };
  }

  /** Whether a scheduled check is due, mirroring isUpdateCheckDue for services. */
  isCheckDue(state, { now = this.now(), intervalMs = CHECK_INTERVAL_MS } = {}) {
    const last = state?.checkedAt;

    if (!last) {
      return true;
    }

    const parsed = Date.parse(last);

    return !Number.isFinite(parsed) || now - parsed >= intervalMs;
  }
}
