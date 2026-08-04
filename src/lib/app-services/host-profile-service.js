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
    normalizeSettingsImpl = normalizeSettings,
    saveSettingsImpl = saveSettings,
    validateHostProfileImpl = validateHostProfile,
    writeStacksImpl = writeStacks
  } = {}) {
    this.appendActivity = appendActivityImpl;
    this.detectHostEnvironment = detectHostEnvironmentImpl;
    this.loadSettingsImpl = loadSettingsImpl;
    this.normalizeSettings = normalizeSettingsImpl;
    this.saveSettings = saveSettingsImpl;
    this.validateHostProfile = validateHostProfileImpl;
    this.writeStacks = writeStacksImpl;
  }

  async loadSettings() {
    return this.loadSettingsImpl();
  }

  buildCandidateSettings(rawSettings, detection) {
    return {
      ...detection?.selected?.suggestedSettings,
      ...rawSettings,
      adapterType: rawSettings.adapterType || detection?.selected?.adapterId || "generic-docker",
      hostLabel: rawSettings.hostLabel || detection?.selected?.suggestedSettings?.hostLabel || "Docker Host"
    };
  }

  async inspectHostDraft(rawSettings = {}) {
    const detection = await this.detectHostEnvironment(rawSettings);
    const candidateSettings = this.buildCandidateSettings(rawSettings, detection);
    const effectiveSettings = this.normalizeSettings({
      ...candidateSettings,
      initialized: rawSettings.initialized === true
    });
    const validation = await this.validateHostProfile(effectiveSettings);

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
        hostDetection: null
      };
    }

    const hostDetection = await this.inspectHostDraft(settings);
    return {
      settings: this.normalizeSettings(applyDetectionSuggestions(settings, hostDetection.selected)),
      hostDetection
    };
  }

  async detectHost(input = null) {
    const savedSettings = await this.loadSettings();
    const draftSettings = input
      ? {
          ...savedSettings,
          ...input,
          initialized: savedSettings.initialized
        }
      : savedSettings;

    return this.inspectHostDraft(draftSettings);
  }

  async prepareSetup(input = {}) {
    const deploy = input?.deploy === true;
    const rawSettings = { ...input };
    delete rawSettings.deploy;

    const inspection = await this.inspectHostDraft(rawSettings);
    const candidateSettings = inspection.effectiveSettings;
    const validation = inspection.validation;

    if (!validation.ok) {
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
}
