import { readFile } from "node:fs/promises";

import { buildImportDraftArtifacts, buildImportPreview } from "../import-planner.js";
import { scanDockerInventory } from "../import-scanner.js";
import {
  backupService,
  composeDown,
  containerExists,
  generateAndDeploy,
  renameContainer,
  startContainer,
  stopContainer
} from "../runtime.js";
import { HEALTH_OUTCOME, verifyServiceHealth } from "../health.js";
import { appendActivity, loadSettings, saveSettings } from "../store.js";
import { JobRegistry } from "../jobs.js";
import { KeelarrError } from "../errors.js";
import { defaultLogger } from "../logger.js";

export const ROLLBACK_SUFFIX = "-keelarr-rollback";

export const CUTOVER_STEPS = [
  { name: "preflight", label: "Verify the draft still matches the live container" },
  { name: "backup", label: "Back up compose, env, inspect, and image identity" },
  { name: "stop", label: "Stop the live container" },
  { name: "rename", label: "Rename the live container to the rollback name" },
  { name: "deploy", label: "Start the managed Compose service" },
  { name: "verify", label: "Confirm the replacement is healthy" },
  { name: "revert", label: "Roll back to the original container" },
  { name: "finalize", label: "Record managed state" }
];

export const REVERT_STEPS = [
  { name: "preflight", label: "Locate the rollback container" },
  { name: "compose-down", label: "Remove the managed Compose container" },
  { name: "restore", label: "Rename and start the original container" },
  { name: "verify", label: "Confirm the original container is healthy" },
  { name: "finalize", label: "Record draft state" }
];

export function rollbackNameFor(containerName) {
  return `${containerName}${ROLLBACK_SUFFIX}`;
}

export function isImportedMode(mode) {
  return mode === "imported-draft" || mode === "imported";
}

export class CutoverService {
  constructor({
    appendActivityImpl = appendActivity,
    backupServiceImpl = backupService,
    buildImportDraftArtifactsImpl = buildImportDraftArtifacts,
    buildImportPreviewImpl = buildImportPreview,
    composeDownImpl = composeDown,
    containerExistsImpl = containerExists,
    generateAndDeployImpl = generateAndDeploy,
    hostProfileService = null,
    jobs = null,
    loadSettingsImpl = loadSettings,
    logger = defaultLogger,
    readFileImpl = readFile,
    renameContainerImpl = renameContainer,
    saveSettingsImpl = saveSettings,
    scanDockerInventoryImpl = scanDockerInventory,
    startContainerImpl = startContainer,
    stopContainerImpl = stopContainer,
    verifyServiceHealthImpl = verifyServiceHealth,
    verifyOptions = {}
  } = {}) {
    this.appendActivity = appendActivityImpl;
    this.backupService = backupServiceImpl;
    this.buildImportDraftArtifacts = buildImportDraftArtifactsImpl;
    this.buildImportPreview = buildImportPreviewImpl;
    this.composeDown = composeDownImpl;
    this.containerExists = containerExistsImpl;
    this.generateAndDeploy = generateAndDeployImpl;
    this.hostProfileService = hostProfileService;
    this.jobs = jobs || new JobRegistry({ logger, persist: true });
    this.loadSettingsImpl = loadSettingsImpl;
    this.logger = logger.child({ component: "cutover-service" });
    this.readFile = readFileImpl;
    this.renameContainer = renameContainerImpl;
    this.saveSettings = saveSettingsImpl;
    this.scanDockerInventory = scanDockerInventoryImpl;
    this.startContainer = startContainerImpl;
    this.stopContainer = stopContainerImpl;
    this.verifyServiceHealth = verifyServiceHealthImpl;
    this.verifyOptions = verifyOptions;
  }

  async loadSettings() {
    if (this.hostProfileService) {
      return this.hostProfileService.loadSettings();
    }

    return this.loadSettingsImpl();
  }

  scopedLogger(context = {}) {
    return context.requestId ? this.logger.child({ requestId: context.requestId }) : this.logger;
  }

  requireOk(result, message) {
    if (!result?.ok) {
      throw new KeelarrError(message, {
        statusCode: 500,
        details: {
          stdout: result?.stdout || null,
          stderr: result?.stderr || null
        }
      });
    }

    return result;
  }

  /**
   * Confirms the on-disk draft still describes the container we are about to
   * replace. Without this, a container recreated or reconfigured since the
   * draft was written would be silently rolled back to the older shape.
   */
  async assertDraftMatchesLiveContainer(settings, service, item) {
    const rebuilt = this.buildImportDraftArtifacts(settings, item);
    let onDisk;

    try {
      onDisk = await this.readFile(service.composePath, "utf8");
    } catch {
      throw new KeelarrError(`Managed draft is missing at ${service.composePath}. Regenerate it before cutover.`, {
        statusCode: 409
      });
    }

    if (onDisk.trim() !== rebuilt.composeYaml.trim()) {
      throw new KeelarrError(
        `The live container no longer matches the reviewed draft for ${service.name}. Regenerate the draft and review it again before cutover.`,
        {
          statusCode: 409,
          details: { composePath: service.composePath }
        }
      );
    }

    return rebuilt;
  }

  async findLiveContainer(settings, containerId, context) {
    const inventory = await this.scanDockerInventory(settings, {
      includeSensitive: true,
      logger: this.scopedLogger(context).child({ inventory: "docker", containerId })
    });
    const item = inventory.items.find((candidate) => candidate.containerId === containerId);

    if (!item) {
      throw new KeelarrError(`Unknown cutover candidate: ${containerId}`, { statusCode: 404 });
    }

    return item;
  }

  async persistMode(settings, serviceId, patch) {
    const existing = settings.serviceOverrides?.[serviceId] || {};

    return this.saveSettings({
      ...settings,
      serviceOverrides: {
        ...(settings.serviceOverrides || {}),
        [serviceId]: { ...existing, ...patch }
      }
    });
  }

  startCutover(containerId, input = {}, context = {}) {
    const job = this.jobs.create({
      kind: "cutover",
      subject: { containerId },
      steps: CUTOVER_STEPS
    });

    return this.jobs.start(job, (ctx) => this.runCutover(ctx, containerId, input, context));
  }

  async runCutover(ctx, containerId, input, context) {
    const logger = this.scopedLogger(context);
    let plan = null;

    const prepared = await ctx.step("preflight", async () => {
      const settings = await this.loadSettings();

      if (settings.initialized !== true) {
        throw new KeelarrError("Configure the host profile before running a cutover.", { statusCode: 400 });
      }

      const item = await this.findLiveContainer(settings, containerId, context);

      // The confirmation gate. A stray POST cannot migrate a service; the
      // caller has to name the container it believes it is replacing.
      if (input.confirmContainerName !== item.containerName) {
        throw new KeelarrError(
          `Cutover confirmation does not match. Expected the container name ${item.containerName}.`,
          { statusCode: 400 }
        );
      }

      const service = settings.services[item.serviceId];

      if (!service) {
        throw new KeelarrError(`Service ${item.serviceId} is not selected in this stack.`, { statusCode: 404 });
      }

      if (service.managedMode !== "imported-draft") {
        throw new KeelarrError(
          `${service.name} has no reviewed import draft to cut over. Generate the managed draft first.`,
          { statusCode: 409 }
        );
      }

      const preview = await this.buildImportPreview(settings, item);

      if (!preview.supported || !preview.adoptable) {
        throw new KeelarrError(`${service.name} still has unresolved adoption issues.`, { statusCode: 409 });
      }

      await this.assertDraftMatchesLiveContainer(settings, service, item);

      const rollbackName = rollbackNameFor(item.containerName);

      // A leftover rollback container from an earlier attempt would make the
      // rename fail halfway through, after the live container is already down.
      if (await this.containerExists(settings, rollbackName, { logger })) {
        throw new KeelarrError(
          `A previous rollback container named ${rollbackName} still exists. Revert or remove it before cutting over again.`,
          { statusCode: 409 }
        );
      }

      plan = { settings, service, item, rollbackName };
      return { detail: `Draft matches live container ${item.containerName}.` };
    });

    const { settings, service, item, rollbackName } = plan;
    const stepLogger = logger.child({ serviceId: service.id, containerName: item.containerName });

    const backup = await ctx.step("backup", async () => {
      const result = await this.backupService(settings, service, { logger: stepLogger });
      return { detail: `Backed up to ${result.backupDir}.`, ...result };
    });

    await ctx.step("stop", async () => {
      this.requireOk(
        await this.stopContainer(settings, item.containerName, { logger: stepLogger }),
        `Unable to stop ${item.containerName}.`
      );
      return { detail: `Stopped ${item.containerName}.` };
    });

    await ctx.step("rename", async () => {
      this.requireOk(
        await this.renameContainer(settings, item.containerName, rollbackName, { logger: stepLogger }),
        `Unable to rename ${item.containerName} to ${rollbackName}.`
      );
      return { detail: `Preserved the original container as ${rollbackName}.` };
    });

    await ctx.step("deploy", async () => {
      const result = await this.generateAndDeploy(settings, service, { logger: stepLogger });

      if (!result.ok) {
        // Compose never took over, so put the original container back before
        // surfacing the failure.
        await this.revertInPlace(ctx, settings, service, rollbackName, stepLogger);
        throw new KeelarrError(`Compose failed to start ${service.name}. The original container was restored.`, {
          statusCode: 500,
          details: { stdout: result.stdout, stderr: result.stderr, reverted: true }
        });
      }

      return { detail: `Started ${service.name} under Compose.` };
    });

    const health = await ctx.step("verify", async () => {
      const result = await this.verifyServiceHealth(settings, service, {
        ...this.verifyOptions,
        logger: stepLogger
      });
      return { detail: result.reason, ...result };
    });

    if (health.outcome === HEALTH_OUTCOME.FAILED) {
      await this.revertInPlace(ctx, settings, service, rollbackName, stepLogger);
      throw new KeelarrError(`${service.name} did not come up under Compose. The original container was restored.`, {
        statusCode: 500,
        details: { reason: health.reason, reverted: true }
      });
    }

    ctx.skip("revert", "Not needed.");

    await ctx.step("finalize", async () => {
      await this.persistMode(settings, service.id, {
        mode: "imported",
        cutoverAt: new Date().toISOString(),
        rollbackContainerName: rollbackName
      });

      await this.appendActivity({
        kind: "cutover",
        level: health.outcome === HEALTH_OUTCOME.VERIFIED ? "info" : "warn",
        message: health.outcome === HEALTH_OUTCOME.VERIFIED
          ? `Cut over ${service.name} to Compose management.`
          : `Cut over ${service.name}, but health could not be confirmed.`,
        details: { serviceId: service.id, rollbackContainerName: rollbackName }
      });

      return { detail: `${service.name} is now Compose-managed.` };
    });

    logger.info("service.cutover", {
      serviceId: service.id,
      containerName: item.containerName,
      rollbackContainerName: rollbackName,
      outcome: health.outcome
    });

    return {
      outcome: health.outcome,
      serviceId: service.id,
      serviceName: service.name,
      containerName: item.containerName,
      rollbackContainerName: rollbackName,
      backupDir: backup.backupDir,
      rollback: backup.rollback,
      health,
      // Deliberately kept even on success: the operator decides when the old
      // container is safe to delete, not Keelarr.
      cleanupHint: `The original container is preserved as ${rollbackName}. Remove it once ${service.name} has been used successfully.`
    };
  }

  /**
   * Best-effort restore used inside a failing cutover. Errors here are
   * recorded on the step but never mask the original failure.
   */
  async revertInPlace(ctx, settings, service, rollbackName, logger) {
    try {
      await ctx.step("revert", async () => {
        await this.composeDown(settings, service, { logger });
        this.requireOk(
          await this.renameContainer(settings, rollbackName, service.containerName, { logger }),
          `Unable to rename ${rollbackName} back to ${service.containerName}.`
        );
        this.requireOk(
          await this.startContainer(settings, service.containerName, { logger }),
          `Unable to restart ${service.containerName}.`
        );

        await this.appendActivity({
          kind: "cutover-revert",
          level: "warn",
          message: `Rolled back ${service.name} to the original container.`,
          details: { serviceId: service.id }
        });

        return { detail: `Restored ${service.containerName}.` };
      });
    } catch (error) {
      logger.error("service.cutover_revert_failed", {
        serviceId: service.id,
        rollbackContainerName: rollbackName,
        message: error.message
      });
    }
  }

  startRevert(serviceId, input = {}, context = {}) {
    const job = this.jobs.create({
      kind: "cutover-revert",
      subject: { serviceId },
      steps: REVERT_STEPS
    });

    return this.jobs.start(job, (ctx) => this.runRevert(ctx, serviceId, input, context));
  }

  async runRevert(ctx, serviceId, input, context) {
    const logger = this.scopedLogger(context);
    let plan = null;

    await ctx.step("preflight", async () => {
      const settings = await this.loadSettings();
      const service = settings.services[serviceId];

      if (!service) {
        throw new KeelarrError(`Unknown or disabled service: ${serviceId}`, { statusCode: 404 });
      }

      if (input.confirmContainerName !== service.containerName) {
        throw new KeelarrError(
          `Revert confirmation does not match. Expected the container name ${service.containerName}.`,
          { statusCode: 400 }
        );
      }

      const rollbackName = settings.serviceOverrides?.[serviceId]?.rollbackContainerName
        || rollbackNameFor(service.containerName);

      if (!(await this.containerExists(settings, rollbackName, { logger }))) {
        throw new KeelarrError(
          `No rollback container named ${rollbackName} exists. This service cannot be reverted automatically.`,
          { statusCode: 409 }
        );
      }

      plan = { settings, service, rollbackName };
      return { detail: `Found rollback container ${rollbackName}.` };
    });

    const { settings, service, rollbackName } = plan;
    const stepLogger = logger.child({ serviceId: service.id, containerName: service.containerName });

    await ctx.step("compose-down", async () => {
      this.requireOk(
        await this.composeDown(settings, service, { logger: stepLogger }),
        `Unable to stop the managed Compose service for ${service.name}.`
      );
      return { detail: `Removed the Compose container for ${service.name}.` };
    });

    await ctx.step("restore", async () => {
      this.requireOk(
        await this.renameContainer(settings, rollbackName, service.containerName, { logger: stepLogger }),
        `Unable to rename ${rollbackName} back to ${service.containerName}.`
      );
      this.requireOk(
        await this.startContainer(settings, service.containerName, { logger: stepLogger }),
        `Unable to start ${service.containerName}.`
      );
      return { detail: `Restored ${service.containerName}.` };
    });

    const health = await ctx.step("verify", async () => {
      const result = await this.verifyServiceHealth(settings, service, {
        ...this.verifyOptions,
        logger: stepLogger
      });
      return { detail: result.reason, ...result };
    });

    await ctx.step("finalize", async () => {
      // Auto-update was opted into as a managed app. Back on the original
      // container there is no stack for a scheduled install to act on, and
      // an AUTO tag on a row Keelarr no longer owns would be a lie.
      await this.persistMode(settings, service.id, {
        mode: "imported-draft",
        cutoverAt: null,
        rollbackContainerName: null,
        autoUpdate: false
      });

      await this.appendActivity({
        kind: "cutover-revert",
        level: "warn",
        message: `Reverted ${service.name} to the original container.`,
        details: { serviceId: service.id }
      });

      return { detail: `${service.name} is back on the original container.` };
    });

    logger.warn("service.cutover_reverted", {
      serviceId: service.id,
      containerName: service.containerName,
      outcome: health.outcome
    });

    return {
      outcome: health.outcome,
      serviceId: service.id,
      serviceName: service.name,
      containerName: service.containerName,
      health
    };
  }

  getJob(jobId) {
    return this.jobs.get(jobId);
  }

  listJobs() {
    return this.jobs.list();
  }
}
