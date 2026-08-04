import { writeDraftFiles } from "../generator.js";
import {
  buildImportDraftArtifacts,
  buildImportPreview,
  buildImportReviewArtifacts
} from "../import-planner.js";
import { scanDockerInventory } from "../import-scanner.js";
import { appendActivity, loadSettings, saveSettings } from "../store.js";
import { StackarrError } from "../errors.js";

export class ImportService {
  constructor({
    appendActivityImpl = appendActivity,
    buildImportPreviewImpl = buildImportPreview,
    buildImportReviewArtifactsImpl = buildImportReviewArtifacts,
    buildImportDraftArtifactsImpl = buildImportDraftArtifacts,
    hostProfileService = null,
    loadSettingsImpl = loadSettings,
    saveSettingsImpl = saveSettings,
    scanDockerInventoryImpl = scanDockerInventory
  } = {}) {
    this.appendActivity = appendActivityImpl;
    this.buildImportPreview = buildImportPreviewImpl;
    this.buildImportReviewArtifacts = buildImportReviewArtifactsImpl;
    this.buildImportDraftArtifacts = buildImportDraftArtifactsImpl;
    this.hostProfileService = hostProfileService;
    this.loadSettingsImpl = loadSettingsImpl;
    this.saveSettings = saveSettingsImpl;
    this.scanDockerInventory = scanDockerInventoryImpl;
  }

  async loadSettings() {
    if (this.hostProfileService) {
      return this.hostProfileService.loadSettings();
    }

    return this.loadSettingsImpl();
  }

  async scanImportInventory() {
    const settings = await this.loadSettings();
    return this.scanDockerInventory(settings);
  }

  async previewImport(containerId) {
    const settings = await this.loadSettings();
    const item = await this.findImportCandidate(settings, containerId);
    return this.buildImportPreview(settings, item);
  }

  async adoptImportAsDraft(containerId) {
    const settings = await this.loadSettings();
    if (!settings.initialized) {
      throw new StackarrError("Configure the host profile before adopting an existing container into a managed draft.", {
        statusCode: 400
      });
    }

    const item = await this.findImportCandidate(settings, containerId, {
      includeSensitive: true
    });
    const preview = await this.buildImportPreview(settings, item);

    if (!preview.supported || !preview.adoptable || !item.serviceId) {
      throw new StackarrError("This container cannot be turned into a managed draft until the adoption issues are resolved.", {
        statusCode: 400
      });
    }

    const nextSelectedServiceIds = settings.selectedServiceIds.includes(item.serviceId)
      ? settings.selectedServiceIds
      : [...settings.selectedServiceIds, item.serviceId];

    const nextSettings = nextSelectedServiceIds === settings.selectedServiceIds
      ? settings
      : await this.saveSettings({
          ...settings,
          selectedServiceIds: nextSelectedServiceIds
        });

    const reviewArtifacts = this.buildImportReviewArtifacts(preview);
    const draft = {
      ...this.buildImportDraftArtifacts(nextSettings, item),
      reviewSummary: reviewArtifacts.summary,
      reviewNotes: reviewArtifacts.markdown
    };
    const generated = await writeDraftFiles(draft);
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

  async findImportCandidate(settings, containerId, options = {}) {
    const inventory = await this.scanDockerInventory(settings, options);
    const item = inventory.items.find((candidate) => candidate.containerId === containerId);

    if (!item) {
      throw new StackarrError(`Unknown import candidate: ${containerId}`, {
        statusCode: 404
      });
    }

    return item;
  }
}
