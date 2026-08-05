import { writeStacks } from "../generator.js";
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
import { StackarrError } from "../errors.js";
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
    loadSettingsImpl = loadSettings,
    logger = defaultLogger,
    normalizeSettingsImpl = normalizeSettings,
    saveSettingsImpl = saveSettings,
    validateHostProfileImpl = validateHostProfile,
    writeStacksImpl = writeStacks
  } = {}) {
    this.appendActivity = appendActivityImpl;
    this.detectHostEnvironment = detectHostEnvironmentImpl;
    this.loadSettingsImpl = loadSettingsImpl;
    this.logger = logger.child({
      component: "host-profile-service"
    });
    this.normalizeSettings = normalizeSettingsImpl;
    this.saveSettings = saveSettingsImpl;
    this.validateHostProfile = validateHostProfileImpl;
    this.writeStacks = writeStacksImpl;
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

  async inspectHostDraft(rawSettings = {}, context = {}) {
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
      throw new StackarrError(summarizeValidationErrors(validation), {
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
      effectiveSettings: inspection.effectiveSettings
    };
  }

  async prepareSetup(input = {}, context = {}) {
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
      throw new StackarrError(summarizeValidationErrors(validation), {
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
