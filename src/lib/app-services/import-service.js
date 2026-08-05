import { writeDraftFiles } from "../generator.js";
import {
  buildImportDraftArtifacts,
  buildImportPreview,
  buildImportReviewArtifacts
} from "../import-planner.js";
import { scanDockerInventory } from "../import-scanner.js";
import { appendActivity, loadSettings, normalizeSettings, saveSettings } from "../store.js";
import { StackarrError } from "../errors.js";
import { defaultLogger } from "../logger.js";

export class ImportService {
  constructor({
    appendActivityImpl = appendActivity,
    buildImportPreviewImpl = buildImportPreview,
    buildImportReviewArtifactsImpl = buildImportReviewArtifacts,
    buildImportDraftArtifactsImpl = buildImportDraftArtifacts,
    hostProfileService = null,
    loadSettingsImpl = loadSettings,
    logger = defaultLogger,
    normalizeSettingsImpl = normalizeSettings,
    saveSettingsImpl = saveSettings,
    scanDockerInventoryImpl = scanDockerInventory,
    writeDraftFilesImpl = writeDraftFiles
  } = {}) {
    this.appendActivity = appendActivityImpl;
    this.buildImportPreview = buildImportPreviewImpl;
    this.buildImportReviewArtifacts = buildImportReviewArtifactsImpl;
    this.buildImportDraftArtifacts = buildImportDraftArtifactsImpl;
    this.hostProfileService = hostProfileService;
    this.loadSettingsImpl = loadSettingsImpl;
    this.logger = logger.child({
      component: "import-service"
    });
    this.normalizeSettings = normalizeSettingsImpl;
    this.saveSettings = saveSettingsImpl;
    this.scanDockerInventory = scanDockerInventoryImpl;
    this.writeDraftFiles = writeDraftFilesImpl;
  }

  async loadSettings() {
    if (this.hostProfileService) {
      return this.hostProfileService.loadSettings();
    }

    return this.loadSettingsImpl();
  }

  scopedLogger(context = {}) {
    return context.requestId
      ? this.logger.child({ requestId: context.requestId })
      : this.logger;
  }

  async scanImportInventory(context = {}) {
    const settings = await this.loadSettings();
    const inventory = await this.scanDockerInventory(settings, {
      logger: this.scopedLogger(context).child({
        inventory: "docker"
      })
    });
    this.scopedLogger(context).info("import.scan", inventory.summary);
    return inventory;
  }

  async previewImport(containerId, context = {}) {
    const settings = await this.loadSettings();
    const item = await this.findImportCandidate(settings, containerId, {}, context);
    const preview = await this.buildImportPreview(settings, item);
    this.scopedLogger(context).info("import.preview", {
      containerId,
      serviceId: preview.target?.serviceId || null,
      supported: preview.supported === true,
      adoptable: preview.adoptable === true,
      warningCount: Array.isArray(preview.warnings) ? preview.warnings.length : 0
    });
    return preview;
  }

  async adoptImportAsDraft(containerId, context = {}) {
    const settings = await this.loadSettings();
    if (!settings.initialized) {
      throw new StackarrError("Configure the host profile before adopting an existing container into a managed draft.", {
        statusCode: 400
      });
    }

    const logger = this.scopedLogger(context);
    const item = await this.findImportCandidate(settings, containerId, {
      includeSensitive: true
    }, context);
    const preview = await this.buildImportPreview(settings, item);

    if (!preview.supported || !preview.adoptable || !item.serviceId) {
      throw new StackarrError("This container cannot be turned into a managed draft until the adoption issues are resolved.", {
        statusCode: 400
      });
    }

    const nextSelectedServiceIds = settings.selectedServiceIds.includes(item.serviceId)
      ? settings.selectedServiceIds
      : [...settings.selectedServiceIds, item.serviceId];

    const nextSettingsBase = {
      ...settings,
      selectedServiceIds: nextSelectedServiceIds
    };
    const importedOverride = {
      mode: "imported-draft",
      image: preview.target.image,
      port: preview.target.port,
      containerName: preview.target.containerName,
      restartPolicy: preview.target.restartPolicy,
      networkMode: preview.target.networkMode,
      envKeys: preview.draft?.envKeys || [],
      sourceContainerId: item.containerId,
      sourceContainerName: item.containerName,
      sourceImage: item.image,
      reviewSummaryPath: preview.draftArtifacts?.reviewSummaryPath || `${preview.target.stackDir}/import-summary.json`,
      reviewNotesPath: preview.draftArtifacts?.reviewNotesPath || `${preview.target.stackDir}/IMPORT-REVIEW.md`,
      importedAt: new Date().toISOString()
    };
    const nextSettingsDraft = this.normalizeSettings({
      ...nextSettingsBase,
      serviceOverrides: {
        ...(settings.serviceOverrides || {}),
        [item.serviceId]: importedOverride
      }
    });
    const nextPreview = await this.buildImportPreview(nextSettingsDraft, item);
    const reviewArtifacts = this.buildImportReviewArtifacts(nextPreview);
    const draft = {
      ...this.buildImportDraftArtifacts(nextSettingsDraft, item),
      reviewSummary: reviewArtifacts.summary,
      reviewNotes: reviewArtifacts.markdown
    };
    const generated = await this.writeDraftFiles(draft);

    const nextSettings = await this.saveSettings({
      ...nextSettingsDraft,
      serviceOverrides: {
        ...(nextSettingsDraft.serviceOverrides || {}),
        [item.serviceId]: {
          ...importedOverride,
          reviewSummaryPath: generated.reviewSummaryPath,
          reviewNotesPath: generated.reviewNotesPath
        }
      }
    });
    logger.info("import.adopt_draft", {
      containerId: item.containerId,
      containerName: item.containerName,
      serviceId: item.serviceId,
      serviceName: item.serviceName,
      composePath: generated.composePath,
      envPath: generated.envPath,
      reviewSummaryPath: generated.reviewSummaryPath,
      reviewNotesPath: generated.reviewNotesPath
    });
    await this.appendActivity({
      kind: "import-draft",
      level: "info",
      message: `Generated a managed draft for ${item.serviceName} from ${item.containerName}.`,
      details: {
        containerId: item.containerId,
        serviceId: item.serviceId
      }
    });

    return {
      ok: true,
      preview: await this.buildImportPreview(nextSettings, item),
      generated
    };
  }

  async findImportCandidate(settings, containerId, options = {}, context = {}) {
    const inventory = await this.scanDockerInventory(settings, {
      ...options,
      logger: this.scopedLogger(context).child({
        inventory: "docker",
        containerId
      })
    });
    const item = inventory.items.find((candidate) => candidate.containerId === containerId);

    if (!item) {
      throw new StackarrError(`Unknown import candidate: ${containerId}`, {
        statusCode: 404
      });
    }

    return item;
  }
}
