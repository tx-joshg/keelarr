import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";

import { writeStacks } from "../generator.js";
import { inspectContainers } from "../runtime.js";
import { findUnmountedRoots, renderControllerEnv, resolveControllerEnvPath } from "../host-mounts.js";
import {
  applyDetectionSuggestions,
  detectHostEnvironment,
  validateHostProfile
} from "../host-adapters/index.js";
import {
  appendActivity,
  loadSettings,
  normalizeSettings,
  saveSettings
} from "../store.js";
import { KeelarrError } from "../errors.js";
import { defaultLogger } from "../logger.js";
import { listDirectories } from "../path-browser.js";

function summarizeValidationErrors(validation) {
  if (!Array.isArray(validation?.errors) || validation.errors.length === 0) {
    return "Host validation failed.";
  }

  return validation.errors.join(" ");
}

export class HostProfileService {
  constructor({
    appendActivityImpl = appendActivity,
    detectHostEnvironmentImpl = detectHostEnvironment,
    inspectContainersImpl = inspectContainers,
    loadSettingsImpl = loadSettings,
    readFileImpl = readFile,
    logger = defaultLogger,
    normalizeSettingsImpl = normalizeSettings,
    saveSettingsImpl = saveSettings,
    validateHostProfileImpl = validateHostProfile,
    writeFileImpl = writeFile,
    writeStacksImpl = writeStacks,
    hostDetectionTtlMs = 60_000
  } = {}) {
    this.appendActivity = appendActivityImpl;
    this.detectHostEnvironment = detectHostEnvironmentImpl;
    this.inspectContainers = inspectContainersImpl;
    this.loadSettingsImpl = loadSettingsImpl;
    this.readFile = readFileImpl;
    this.logger = logger.child({
      component: "host-profile-service"
    });
    this.normalizeSettings = normalizeSettingsImpl;
    this.saveSettings = saveSettingsImpl;
    this.validateHostProfile = validateHostProfileImpl;
    this.writeFile = writeFileImpl;
    this.writeStacks = writeStacksImpl;
    this.hostDetectionTtlMs = hostDetectionTtlMs;
    this.hostDetectionCache = null;
  }

  async loadSettings() {
    return this.loadSettingsImpl();
  }

  scopedLogger(context = {}) {
    return context.requestId
      ? this.logger.child({ requestId: context.requestId })
      : this.logger;
  }

  buildCandidateSettings(rawSettings, detection, options = {}) {
    const preferredAdapterId = options.preferredAdapterId || null;
    const selectedSuggestions = detection?.selected?.suggestedSettings || {};
    const selectedAdapterId = detection?.selected?.adapterId || rawSettings.adapterType || "generic-docker";
    const preferredSelection = preferredAdapterId && detection?.selected?.adapterId === preferredAdapterId;
    const preserveSavedValues = rawSettings.initialized === true && !preferredSelection;

    if (!preserveSavedValues) {
      return {
        ...rawSettings,
        ...selectedSuggestions,
        adapterType: selectedAdapterId,
        hostLabel: selectedSuggestions.hostLabel || rawSettings.hostLabel || "Docker Host"
      };
    }

    return {
      ...selectedSuggestions,
      ...rawSettings,
      adapterType: rawSettings.adapterType || selectedAdapterId,
      hostLabel: rawSettings.hostLabel || selectedSuggestions.hostLabel || "Docker Host"
    };
  }

  resolvePreferredAdapterId(rawSettings = {}) {
    if (rawSettings.preferredAdapterId) {
      return rawSettings.preferredAdapterId;
    }

    return rawSettings.initialized === true
      ? rawSettings.adapterType || null
      : null;
  }

  extractDraftSettings(input = {}) {
    const rawSettings = { ...input };
    delete rawSettings.deploy;
    delete rawSettings.preferredAdapterId;
    return rawSettings;
  }

  /**
   * Host detection probes every Docker binary candidate across every adapter,
   * each spawning `docker version` and `docker compose version`. That is
   * setup-time work — running it on every dashboard poll cost seconds per
   * refresh. The result only changes when the host profile does, so it is
   * cached and explicitly invalidated on save/detect.
   */
  hostDetectionCacheKey(rawSettings = {}) {
    return JSON.stringify([
      rawSettings.adapterType || null,
      rawSettings.dockerBin || null,
      rawSettings.stackRoot || null,
      rawSettings.configRoot || null,
      rawSettings.mediaRoot || null,
      rawSettings.downloadsRoot || null,
      rawSettings.plexLogsRoot || null,
      rawSettings.initialized === true,
      this.resolvePreferredAdapterId(rawSettings) || null
    ]);
  }

  invalidateHostDetection() {
    this.hostDetectionCache = null;
  }

  async inspectHostDraft(rawSettings = {}, context = {}) {
    const key = this.hostDetectionCacheKey(rawSettings);
    const cached = this.hostDetectionCache;

    if (cached && cached.key === key && Date.now() - cached.at < this.hostDetectionTtlMs) {
      return cached.value;
    }

    const value = await this.runHostInspection(rawSettings, context);
    this.hostDetectionCache = { key, at: Date.now(), value };
    return value;
  }

  async runHostInspection(rawSettings = {}, context = {}) {
    const logger = this.scopedLogger(context);
    const preferredAdapterId = this.resolvePreferredAdapterId(rawSettings);
    const draftSettings = this.extractDraftSettings(rawSettings);
    const detection = await this.detectHostEnvironment(draftSettings, {
      logger: logger.child({
        probe: "detect-host"
      }),
      preferredAdapterId
    });
    const candidateSettings = this.buildCandidateSettings(draftSettings, detection, {
      preferredAdapterId
    });
    const effectiveSettings = this.normalizeSettings({
      ...candidateSettings,
      initialized: draftSettings.initialized === true
    });
    const validation = await this.validateHostProfile(effectiveSettings, {
      logger: logger.child({
        probe: "validate-host"
      })
    });

    return {
      ...detection,
      validation,
      effectiveSettings
    };
  }

  async resolveStateSettings() {
    const settings = await this.loadSettings();

    if (settings.initialized) {
      return {
        settings,
        hostDetection: await this.inspectHostDraft(settings)
      };
    }

    const hostDetection = await this.inspectHostDraft(settings);
    return {
      settings: this.normalizeSettings(applyDetectionSuggestions(settings, hostDetection.selected)),
      hostDetection
    };
  }

  async detectHost(input = null, context = {}) {
    this.invalidateHostDetection();
    const savedSettings = await this.loadSettings();
    const draftSettings = input
      ? {
          ...savedSettings,
          ...input,
          initialized: savedSettings.initialized
        }
      : savedSettings;

    const inspection = await this.inspectHostDraft(draftSettings, context);
    this.scopedLogger(context).info("host.detect", {
      adapterId: inspection.selected?.adapterId || null,
      confidence: inspection.selected?.confidence || null,
      validationOk: inspection.validation?.ok === true,
      errors: inspection.validation?.errors || [],
      warnings: inspection.validation?.warnings || []
    });
    return inspection;
  }

  async saveProfile(input = {}, context = {}) {
    this.invalidateHostDetection();
    const logger = this.scopedLogger(context);
    const savedSettings = await this.loadSettings();
    const rawSettings = this.extractDraftSettings(input);
    const baseSettings = {
      ...savedSettings,
      ...rawSettings,
      initialized: savedSettings.initialized
    };

    const inspection = await this.inspectHostDraft(baseSettings, context);
    const candidateSettings = inspection.effectiveSettings;
    const validation = inspection.validation;

    if (!validation.ok) {
      logger.warn("host.save_validation_failed", {
        adapterId: inspection.selected?.adapterId || candidateSettings.adapterType,
        errors: validation.errors,
        warnings: validation.warnings
      });
      throw new KeelarrError(summarizeValidationErrors(validation), {
        statusCode: 400,
        details: {
          ...validation,
          detections: inspection.detections,
          selected: inspection.selected,
          effectiveSettings: inspection.effectiveSettings
        }
      });
    }

    const settings = await this.saveSettings(candidateSettings);
    const controllerEnv = await this.syncControllerEnv(settings, logger);
    logger.info("host.settings_saved", {
      adapterId: settings.adapterType,
      validationWarnings: validation.warnings
    });
    await this.appendActivity({
      kind: "settings-save",
      level: "info",
      message: "Saved host settings.",
      details: {
        adapterId: settings.adapterType,
        validationWarnings: validation.warnings
      }
    });

    return {
      settings,
      detection: inspection,
      validation,
      controllerEnv,
      effectiveSettings: inspection.effectiveSettings
    };
  }

  /**
   * Keeps the controller's own env file in step with these settings.
   *
   * The same host paths were being stored in both places with nothing
   * reconciling them, so a root changed here left the container mounting the
   * old one — and every check then reported a directory that plainly exists as
   * missing. Writing it from settings removes the second source of truth.
   *
   * Returns what happened rather than throwing: failing to update a deployment
   * file is not a reason to refuse a settings save, and when the file cannot be
   * reached from inside the container the rendered content is handed back so it
   * can be applied by hand.
   */
  async syncControllerEnv(settings, logger) {
    try {
      const controller = await this.readControllerDefinition(settings, logger);
      const target = await resolveControllerEnvPath(controller);
      const previous = target ? await this.readFileSafely(target) : "";
      const content = renderControllerEnv(settings, previous);
      // Only a change to the mounted paths needs a recreate. Rewriting the same
      // values on every save should not keep telling the operator to restart.
      const pathsChanged = findUnmountedRoots(settings, controller.mounts).length > 0;

      if (!target) {
        return {
          written: false,
          pathsChanged,
          path: null,
          content,
          message: "Keelarr could not reach its own deploy directory from inside the container, so deploy/.env was not updated. Apply these values by hand and recreate the controller."
        };
      }

      await this.writeFile(target, content, "utf8");
      logger.info("host.controller_env_written", { path: target });

      return {
        written: true,
        pathsChanged,
        path: target,
        content,
        message: `Updated ${target}. Recreate the controller for the new paths to take effect.`
      };
    } catch (error) {
      logger.warn("host.controller_env_failed", { message: error.message });
      return { written: false, path: null, content: null, message: `Could not update deploy/.env: ${error.message}` };
    }
  }

  async readFileSafely(target) {
    try {
      return await this.readFile(target, "utf8");
    } catch {
      return "";
    }
  }

  /** The controller's own compose labels and mounts, read from its container. */
  async readControllerDefinition(settings, logger) {
    const inspects = await this.inspectContainers(settings, [hostname(), "keelarr"], { logger });
    const inspect = inspects[0] || null;
    const labels = inspect?.Config?.Labels || {};

    return {
      workingDir: labels["com.docker.compose.project.working_dir"] || null,
      composeFile: (labels["com.docker.compose.project.config_files"] || "").split(",")[0] || null,
      mounts: (inspect?.Mounts || []).map((mount) => ({ source: mount.Source, target: mount.Destination }))
    };
  }

  async prepareSetup(input = {}, context = {}) {
    this.invalidateHostDetection();
    const logger = this.scopedLogger(context);
    const deploy = input?.deploy === true;
    const rawSettings = this.extractDraftSettings(input);
    const savedSettings = await this.loadSettings();
    const baseSettings = {
      ...savedSettings,
      ...rawSettings,
      initialized: savedSettings.initialized
    };

    const inspection = await this.inspectHostDraft(baseSettings, context);
    const candidateSettings = inspection.effectiveSettings;
    const validation = inspection.validation;

    if (!validation.ok) {
      logger.warn("host.setup_validation_failed", {
        adapterId: inspection.selected?.adapterId || candidateSettings.adapterType,
        errors: validation.errors,
        warnings: validation.warnings
      });
      throw new KeelarrError(summarizeValidationErrors(validation), {
        statusCode: 400,
        details: {
          ...validation,
          detections: inspection.detections,
          selected: inspection.selected,
          effectiveSettings: inspection.effectiveSettings
        }
      });
    }

    const settings = await this.saveSettings(candidateSettings);
    const generated = await this.writeStacks(settings, settings.selectedServiceIds);

    logger.info("host.setup_saved", {
      adapterId: settings.adapterType,
      deploy,
      generatedCount: generated.length,
      validationWarnings: validation.warnings
    });

    await this.appendActivity({
      kind: "setup",
      level: "info",
      message: `Generated ${generated.length} stack folder(s).`,
      details: {
        adapterId: settings.adapterType,
        deploy,
        validationWarnings: validation.warnings
      }
    });

    return {
      settings,
      generated,
      detection: inspection,
      validation,
      effectiveSettings: inspection.effectiveSettings,
      deploy
    };
  }

  async browseDirectories(inputPath = "/", _context = {}) {
    return listDirectories(inputPath);
  }
}
