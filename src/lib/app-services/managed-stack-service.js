import { access } from "node:fs/promises";

import { readComposeImage, setComposeImage, writeStacks } from "../generator.js";
import {
  backupService,
  composeDown,
  ensureSharedNetwork,
  findRollbackPoint,
  imageExistsLocally,
  restoreConfigSnapshot
} from "../runtime.js";
import { SHARED_NETWORK, isImportedMode } from "../service-catalog.js";
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
  readUpdateState,
  writeUpdateState
} from "../store.js";
import { StackarrError } from "../errors.js";
import { defaultLogger } from "../logger.js";

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
    restoreConfigSnapshotImpl = restoreConfigSnapshot,
    installServiceImpl = installService,
    jobs = null,
    loadSettingsImpl = loadSettings,
    logger = defaultLogger,
    readComposeImageImpl = readComposeImage,
    readUpdateStateImpl = readUpdateState,
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
    this.jobs = jobs;
    this.readComposeImage = readComposeImageImpl;
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
      throw new StackarrError(`Unknown or disabled service: ${serviceId}`, {
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
      throw new StackarrError(`Unable to create the shared ${SHARED_NETWORK} network: ${result.error || "unknown error"}`, {
        statusCode: 500
      });
    }

    if (result.created) {
      logger.info("network.created", { network: SHARED_NETWORK });
    }
  }

  /**
   * A deploy or upgrade has just resolved the tag, so whatever the previous
   * update status was is stale. Leaving it would report an upgraded service as
   * still needing an update, or keep showing "rolled-back" after moving on.
   */
  async recordFreshImageState(serviceId) {
    const updateState = await this.readUpdateState();
    updateState[serviceId] = {
      status: "current",
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
        throw new StackarrError(
          `Rollback confirmation does not match. Expected the container name ${service.containerName}.`,
          { statusCode: 400 }
        );
      }

      if (!(await this.serviceIsDeployed(service))) {
        throw new StackarrError(`${service.name} has no managed compose file to roll back.`, {
          statusCode: 409
        });
      }

      const point = await this.findRollbackPoint(settings, service, { logger });

      if (!point) {
        throw new StackarrError(
          `No previous image is recorded for ${service.name}. Rollback is only available after an upgrade or install made a backup.`,
          { statusCode: 409 }
        );
      }

      // Rolling back to an image the host no longer has would leave the
      // service unable to start, so refuse before touching the container.
      if (!(await this.imageExistsLocally(settings, point.imageRef, { logger }))) {
        throw new StackarrError(
          `The previous image for ${service.name} (${point.imageRef}) is no longer present on this host.`,
          { statusCode: 409 }
        );
      }

      const currentImage = await this.readComposeImage(service);
      plan = { settings, service, point, currentImage };
      return { detail: `Rolling back to ${point.taggedImage || point.imageRef} from ${point.backedUpAt || "an earlier backup"}.` };
    });

    const { settings, service, point, currentImage } = plan;
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
        const restored = await this.restoreConfigSnapshot(settings, service, point.backupDir, { logger: stepLogger });

        if (!restored.ok) {
          throw new StackarrError(`Unable to restore the saved configuration for ${service.name}: ${restored.reason}`, {
            statusCode: 500
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
        throw new StackarrError(`Compose failed to start ${service.name} on the previous image.`, {
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
      throw new StackarrError(`${service.name} did not come up on the previous image. The newer image was restored.`, {
        statusCode: 500,
        details: { reason: health.reason, restored: true }
      });
    }

    ctx.skip("restore", "Not needed.");

    await ctx.step("finalize", async () => {
      const updateState = await this.readUpdateState();
      updateState[service.id] = {
        status: "rolled-back",
        checkedAt: new Date().toISOString()
      };
      await this.writeUpdateState(updateState);

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
  async undoPin(ctx, settings, service, previousImage, logger) {
    if (!previousImage) {
      return;
    }

    try {
      await ctx.step("restore", async () => {
        await this.setComposeImage(service, previousImage);
        await this.generateAndDeploy(settings, service, { logger });
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

  async deploySelected(settings, serviceIds = settings.selectedServiceIds, context = {}) {
    const logger = this.scopedLogger(context);
    const deployResults = [];

    for (const serviceId of serviceIds) {
      const service = this.requireService(settings, serviceId);
      await this.prepareNetwork(settings, service, logger);
      const result = await this.generateAndDeploy(settings, service, {
        logger: logger.child({
          serviceId: service.id,
          containerName: service.containerName
        })
      });
      const deployEntry = {
        serviceId,
        ok: result.ok,
        output: `${result.stdout}\n${result.stderr}`.trim()
      };
      deployResults.push(deployEntry);

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

      await this.appendActivity({
        kind: "deploy",
        level: result.ok ? "info" : "error",
        message: result.ok ? `Deployed ${service.name}.` : `Deploy failed for ${service.name}.`,
        details: deployEntry
      });
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
    const settings = await this.loadSettings();
    const service = this.requireService(settings, serviceId);
    const logger = this.scopedLogger(context);
    await this.writeStacks(settings, [service.id]);
    await this.prepareNetwork(settings, service, logger);
    const result = await this.installService(settings, service, {
      logger: logger.child({
        serviceId: service.id,
        containerName: service.containerName
      })
    });

    logger[result.ok ? "info" : "error"]("service.install", {
      serviceId: service.id,
      serviceName: service.name,
      containerName: service.containerName,
      ok: result.ok,
      stdout: result.stdout,
      stderr: result.stderr
    });

    if (result.ok) {
      await this.recordFreshImageState(service.id);
    }

    await this.appendActivity({
      kind: "install",
      level: result.ok ? "info" : "error",
      message: result.ok ? `Installed ${service.name}.` : `Install failed for ${service.name}.`,
      details: {
        stdout: result.stdout,
        stderr: result.stderr
      }
    });

    return {
      ok: result.ok,
      stdout: result.stdout,
      stderr: result.stderr
    };
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

  async upgradeManagedService(serviceId, context = {}) {
    const settings = await this.loadSettings();
    const service = this.requireService(settings, serviceId);
    const logger = this.scopedLogger(context);
    await this.clearRollbackPin(service, logger);
    const result = await this.upgradeService(settings, service, {
      logger: logger.child({
        serviceId: service.id,
        containerName: service.containerName
      })
    });

    logger[result.ok ? "info" : "error"]("service.upgrade", {
      serviceId: service.id,
      serviceName: service.name,
      containerName: service.containerName,
      ok: result.ok,
      stdout: result.stdout,
      stderr: result.stderr
    });

    if (result.ok) {
      await this.recordFreshImageState(service.id);
    }

    await this.appendActivity({
      kind: "upgrade",
      level: result.ok ? "info" : "error",
      message: result.ok ? `Upgraded ${service.name}.` : `Upgrade failed for ${service.name}.`,
      details: {
        stdout: result.stdout,
        stderr: result.stderr
      }
    });

    return {
      ok: result.ok,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  async checkAllUpdates(context = {}) {
    const settings = await this.loadSettings();
    const nextState = await this.readUpdateState();
    const results = [];
    const logger = this.scopedLogger(context);

    for (const serviceId of settings.selectedServiceIds) {
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
        status: result.updateStatus,
        checkedAt: new Date().toISOString()
      };
      results.push({
        serviceId: service.id,
        ok: result.ok,
        updateStatus: result.updateStatus
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

  async upgradeAll(context = {}) {
    const settings = await this.loadSettings();
    const services = settings.selectedServiceIds.map((serviceId) => this.requireService(settings, serviceId));
    const logger = this.scopedLogger(context);
    const results = await this.upgradeAllServices(settings, services, {
      logger
    });
    const ok = results.every((result) => result.ok);

    logger[ok ? "info" : "error"]("service.upgrade_all", {
      ok,
      results
    });

    await this.appendActivity({
      kind: "upgrade-all",
      level: ok ? "info" : "error",
      message: ok ? "Upgraded the full selected stack." : "One or more service upgrades failed.",
      details: results
    });

    return {
      ok,
      results
    };
  }
}
