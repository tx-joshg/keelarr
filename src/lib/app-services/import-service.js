import { writeStacks } from "../generator.js";
import { buildImportPreview } from "../import-planner.js";
import { scanDockerInventory } from "../import-scanner.js";
import { appendActivity, loadSettings, saveSettings } from "../store.js";
import { StackarrError } from "../errors.js";

export class ImportService {
  constructor({
    appendActivityImpl = appendActivity,
    buildImportPreviewImpl = buildImportPreview,
    hostProfileService = null,
    loadSettingsImpl = loadSettings,
    saveSettingsImpl = saveSettings,
    scanDockerInventoryImpl = scanDockerInventory,
    writeStacksImpl = writeStacks
  } = {}) {
    this.appendActivity = appendActivityImpl;
    this.buildImportPreview = buildImportPreviewImpl;
    this.hostProfileService = hostProfileService;
    this.loadSettingsImpl = loadSettingsImpl;
    this.saveSettings = saveSettingsImpl;
    this.scanDockerInventory = scanDockerInventoryImpl;
    this.writeStacks = writeStacksImpl;
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

    const item = await this.findImportCandidate(settings, containerId);
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

    const generated = await this.writeStacks(nextSettings, [item.serviceId]);
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

  async findImportCandidate(settings, containerId) {
    const inventory = await this.scanDockerInventory(settings);
    const item = inventory.items.find((candidate) => candidate.containerId === containerId);

    if (!item) {
      throw new StackarrError(`Unknown import candidate: ${containerId}`, {
        statusCode: 404
      });
    }

    return item;
  }
}
