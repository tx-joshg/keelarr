import { access, rm } from "node:fs/promises";
import path from "node:path";

import {
  backupService,
  composeDown,
  composeDownRemovingVolumes,
  measurePath,
  readConfigMountSource,
  removeImage
} from "../runtime.js";
import { appendActivity, loadSettings, readUpdateState, saveSettings, writeUpdateState } from "../store.js";
import { JobRegistry } from "../jobs.js";
import { KeelarrError } from "../errors.js";
import { defaultLogger } from "../logger.js";

export const REMOVE_STEPS = [
  { name: "preflight", label: "Check what will be removed" },
  { name: "snapshot", label: "Save a final configuration snapshot" },
  { name: "stop", label: "Stop and remove the container" },
  { name: "config", label: "Delete the application configuration" },
  { name: "image", label: "Delete the container image" },
  { name: "stack", label: "Delete the generated stack files" },
  { name: "backups", label: "Delete Keelarr backups" },
  { name: "finalize", label: "Remove from the dashboard" }
];

/**
 * Which apps break when this one goes away. Removing the indexer manager or the
 * download client leaves the Arr apps configured against something that no
 * longer exists, and the operator should hear that before confirming.
 */
const DEPENDENTS = {
  prowlarr: {
    affects: ["radarr", "sonarr", "lidarr"],
    note: "These apps get their indexers from Prowlarr and will stop finding releases."
  },
  sabnzbd: {
    affects: ["radarr", "sonarr", "lidarr"],
    note: "These apps send downloads to SABnzbd and will have no download client."
  }
};

export class RemovalService {
  constructor({
    appendActivityImpl = appendActivity,
    backupServiceImpl = backupService,
    composeDownImpl = composeDown,
    composeDownRemovingVolumesImpl = composeDownRemovingVolumes,
    hostProfileService = null,
    jobs = null,
    loadSettingsImpl = loadSettings,
    logger = defaultLogger,
    measurePathImpl = measurePath,
    pathExistsImpl = async (target) => {
      try {
        await access(target);
        return true;
      } catch {
        return false;
      }
    },
    readConfigMountSourceImpl = readConfigMountSource,
    readUpdateStateImpl = readUpdateState,
    removeImageImpl = removeImage,
    rmImpl = rm,
    saveSettingsImpl = saveSettings,
    writeUpdateStateImpl = writeUpdateState
  } = {}) {
    this.appendActivity = appendActivityImpl;
    this.backupService = backupServiceImpl;
    this.composeDown = composeDownImpl;
    this.composeDownRemovingVolumes = composeDownRemovingVolumesImpl;
    this.hostProfileService = hostProfileService;
    this.jobs = jobs;
    this.loadSettingsImpl = loadSettingsImpl;
    this.logger = logger.child({ component: "removal-service" });
    this.measurePath = measurePathImpl;
    this.readConfigMountSource = readConfigMountSourceImpl;
    this.pathExists = pathExistsImpl;
    this.readUpdateState = readUpdateStateImpl;
    this.removeImage = removeImageImpl;
    this.rm = rmImpl;
    this.saveSettings = saveSettingsImpl;
    this.writeUpdateState = writeUpdateStateImpl;
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

  requireJobs() {
    if (!this.jobs) {
      this.jobs = new JobRegistry({ logger: this.logger, persist: true });
    }

    return this.jobs;
  }

  requireService(settings, serviceId) {
    const service = settings.services[serviceId];

    if (!service) {
      throw new KeelarrError(`Unknown or disabled service: ${serviceId}`, { statusCode: 404 });
    }

    return service;
  }

  /**
   * Finds the app's configuration whether or not its container still exists.
   *
   * Inspecting the container is the accurate route, but a service that failed
   * to start — or was stopped — has no container to inspect. Falling back to
   * the conventional config path means the delete option is still offered
   * instead of silently disappearing and quietly preserving data.
   */
  async resolveConfigTarget(settings, service, logger) {
    const mount = await this.readConfigMountSource(settings, service, { logger });

    if (mount) {
      return mount;
    }

    if (service.configDir && (await this.pathExists(service.configDir))) {
      return { type: "bind", source: service.configDir, inferred: true };
    }

    return null;
  }

  backupRoot(settings, serviceId) {
    return path.join(settings.stackRoot, ".keelarr-backups", serviceId);
  }

  /**
   * Describes exactly what a removal would delete. The dashboard shows this
   * before asking for confirmation, so nobody is guessing what a checkbox does.
   *
   * Media and downloads are deliberately absent: they are shared mounts used by
   * every app in the stack, not data this service owns. Keelarr never offers
   * to delete them.
   */
  async describeRemoval(serviceId, context = {}) {
    const settings = await this.loadSettings();
    const service = this.requireService(settings, serviceId);
    const logger = this.scopedLogger(context);
    const configMount = await this.resolveConfigTarget(settings, service, logger);

    const dependents = DEPENDENTS[serviceId];
    const affected = dependents
      ? dependents.affects.filter((id) => settings.selectedServiceIds.includes(id))
      : [];

    return {
      ok: true,
      serviceId,
      serviceName: service.name,
      containerName: service.containerName,
      imported: service.managedMode !== "catalog",
      targets: {
        container: { label: `Container ${service.containerName}`, always: true },
        stack: { label: "Generated stack files", path: service.stackDir, always: true },
        config: configMount
          ? {
              label: configMount.type === "volume" ? `Named volume ${configMount.source}` : "Configuration and database",
              path: configMount.source,
              type: configMount.type,
              inferred: configMount.inferred === true,
              size: await this.measurePath(settings, configMount.type === "bind" ? configMount.source : null, { logger })
            }
          // Explicitly absent rather than merely missing, so the dialog can say
          // there is no configuration instead of hiding the option.
          : { absent: true, label: "No configuration on disk" },
        image: { label: service.image },
        backups: { label: "Keelarr backups and config snapshots", path: this.backupRoot(settings, serviceId) }
      },
      // Never offered. Named here so the UI can say why rather than staying silent.
      preserved: [
        { label: "Media library", path: settings.mediaRoot, reason: "Shared by every app in the stack." },
        { label: "Downloads", path: settings.downloadsRoot, reason: "Shared by every app in the stack." }
      ],
      warnings: affected.length
        ? [{ level: "warn", message: `${dependents.note} Affected: ${affected.join(", ")}.` }]
        : []
    };
  }

  startRemoval(serviceId, input = {}, context = {}) {
    const job = this.requireJobs().create({
      kind: "remove",
      subject: { serviceId },
      steps: REMOVE_STEPS
    });

    return this.jobs.start(job, (ctx) => this.runRemoval(ctx, serviceId, input, context));
  }

  async runRemoval(ctx, serviceId, input, context) {
    const logger = this.scopedLogger(context);
    let plan = null;

    await ctx.step("preflight", async () => {
      const settings = await this.loadSettings();
      const service = this.requireService(settings, serviceId);

      if (input.confirmContainerName !== service.containerName) {
        throw new KeelarrError(
          `Removal confirmation does not match. Expected the container name ${service.containerName}.`,
          { statusCode: 400 }
        );
      }

      // Read the mount while the container still exists; removing it first
      // would leave nothing to inspect. Resolved even when the configuration is
      // being kept, because the summary has to name what it kept — a named
      // volume looks like nothing at all once the container is gone.
      const configMount = await this.resolveConfigTarget(settings, service, logger);

      plan = { settings, service, configMount };
      return {
        detail: `Removing ${service.name}. Keeping ${input.removeConfig ? "no application data" : "configuration and database"}.`
      };
    });

    const { settings, service, configMount } = plan;
    const stepLogger = logger.child({ serviceId: service.id, containerName: service.containerName });
    const removed = [];
    const kept = [];

    // A snapshot runs whenever backups are being kept, not only when config is
    // about to be destroyed. Its other job is to archive the stack files: an
    // imported service's compose.yml is the only remaining record of what it
    // actually was, and reinstalling without it produces a catalog default
    // pointing at the wrong config location.
    let restoreFrom = null;

    if (!input.removeBackups) {
      await ctx.step("snapshot", async () => {
        try {
          const result = await this.backupService(settings, service, { logger: stepLogger });
          restoreFrom = result?.backupDir || null;
        } catch (error) {
          // When the configuration is about to be destroyed, an unsaved
          // snapshot is the difference between recoverable and gone, so the
          // removal stops. When it is being kept, the data is not at risk and
          // losing the archive only costs the ability to reinstall as the same
          // service — worth reporting, not worth refusing.
          if (input.removeConfig) {
            throw error;
          }

          return { detail: `Could not archive the stack files: ${error.message}. Reinstalling will start this app fresh.` };
        }

        return restoreFrom
          ? { detail: `Snapshot saved to ${restoreFrom}.` }
          : { detail: "No snapshot was produced, so reinstalling will start this app fresh." };
      });
    } else {
      ctx.skip("snapshot", "Backups are being deleted, so a snapshot would be pointless.");
    }

    await ctx.step("stop", async () => {
      // `down -v` only when the config lives in a named volume we are deleting.
      const useVolumes = Boolean(input.removeConfig && configMount?.type === "volume");
      const result = useVolumes
        ? await this.composeDownRemovingVolumes(settings, service, { logger: stepLogger })
        : await this.composeDown(settings, service, { logger: stepLogger });

      if (!result.ok) {
        throw new KeelarrError(`Could not stop ${service.name}.`, {
          statusCode: 500,
          details: { stdout: result.stdout, stderr: result.stderr }
        });
      }

      removed.push("container");
      return { detail: `Removed container ${service.containerName}.` };
    });

    if (input.removeConfig) {
      await ctx.step("config", async () => {
        if (!configMount) {
          return { detail: "No configuration was found on disk." };
        }

        if (configMount.type === "bind") {
          await this.rm(configMount.source, { recursive: true, force: true });
          removed.push("config");
          return { detail: `Deleted ${configMount.source}.` };
        }

        // A named volume is already gone via `down -v`.
        removed.push("config");
        return { detail: "Deleted the configuration volume." };
      });
    } else if (configMount) {
      kept.push("config");
      // Resolved during preflight, while the container still existed. Asking
      // again here would inspect a container that has just been removed and,
      // for a named volume, find nothing at the conventional path either —
      // reporting a database that is very much still there as absent.
      ctx.skip("config", configMount.type === "volume"
        ? `Configuration and database kept in the ${configMount.source} volume.`
        : `Configuration and database kept at ${configMount.source}.`);
    } else {
      // Claiming to have kept something that was never there is a lie the
      // summary should not tell.
      ctx.skip("config", "No configuration exists on disk.");
    }

    if (input.removeImage) {
      await ctx.step("image", async () => {
        const result = await this.removeImage(settings, service.image, { logger: stepLogger });
        if (result.removed) {
          removed.push("image");
        }
        return { detail: result.removed ? `Deleted image ${service.image}.` : result.reason };
      });
    } else {
      kept.push("image");
      ctx.skip("image", "Image kept.");
    }

    await ctx.step("stack", async () => {
      await this.rm(service.stackDir, { recursive: true, force: true });
      removed.push("stack");
      return { detail: `Deleted ${service.stackDir}.` };
    });

    if (input.removeBackups) {
      await ctx.step("backups", async () => {
        await this.rm(this.backupRoot(settings, service.id), { recursive: true, force: true });
        removed.push("backups");
        return { detail: "Deleted backups and config snapshots." };
      });
    } else {
      kept.push("backups");
      ctx.skip("backups", "Backups and config snapshots kept.");
    }

    await ctx.step("finalize", async () => {
      const nextOverrides = { ...(settings.serviceOverrides || {}) };

      if (restoreFrom && !input.removeConfig) {
        // Keep just enough to reinstall the same service. Dropping the whole
        // entry turns an imported service into a catalog one, which then looks
        // for its configuration at a path that has never existed.
        nextOverrides[service.id] = {
          ...(nextOverrides[service.id] || {}),
          mode: service.managedMode,
          image: service.image,
          port: service.port,
          containerName: service.containerName,
          restartPolicy: service.restartPolicy,
          networkMode: service.networkMode,
          restoreFrom
        };
      } else {
        delete nextOverrides[service.id];
      }

      await this.saveSettings({
        ...settings,
        selectedServiceIds: settings.selectedServiceIds.filter((id) => id !== service.id),
        serviceOverrides: nextOverrides
      });

      const updateState = await this.readUpdateState();
      delete updateState[service.id];
      await this.writeUpdateState(updateState);

      await this.appendActivity({
        kind: "remove",
        level: "warn",
        message: `Removed ${service.name}${kept.length ? ` (kept ${kept.join(", ")})` : ""}.`,
        details: { serviceId: service.id, removed, kept }
      });

      return { detail: `${service.name} removed from the dashboard.` };
    });

    logger.warn("service.removed", { serviceId: service.id, removed, kept });

    return {
      serviceId: service.id,
      serviceName: service.name,
      removed,
      kept,
      summary: kept.length
        ? `${service.name} removed. Kept: ${kept.join(", ")}.`
        : `${service.name} and all of its data were removed.`
    };
  }
}
