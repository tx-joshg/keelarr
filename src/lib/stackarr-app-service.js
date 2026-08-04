import { writeStacks } from "./generator.js";
import { detectHostEnvironment, applyDetectionSuggestions } from "./host-adapters/index.js";
import { scanDockerInventory } from "./import-scanner.js";
import { buildImportPreview } from "./import-planner.js";
import { buildDashboardState } from "./status.js";
import {
  appendActivity,
  loadSettings,
  readUpdateState,
  saveSettings,
  writeUpdateState,
  normalizeSettings
} from "./store.js";
import {
  checkForUpdates,
  generateAndDeploy,
  installService,
  upgradeAllServices,
  upgradeService
} from "./runtime.js";
import { listServices } from "./service-catalog.js";
import { StackarrError } from "./errors.js";

export class StackarrAppService {
  async loadSettings() {
    return loadSettings();
  }

  async resolveStateSettings() {
    const settings = await this.loadSettings();

    if (settings.initialized) {
      return {
        settings,
        hostDetection: null
      };
    }

    const hostDetection = await detectHostEnvironment(settings);
    return {
      settings: normalizeSettings(applyDetectionSuggestions(settings, hostDetection.selected)),
      hostDetection
    };
  }

  async buildState() {
    const { settings, hostDetection } = await this.resolveStateSettings();
    const state = await buildDashboardState(settings);

    return {
      ok: true,
      ...state,
      catalog: listServices(),
      hostDetection,
      meta: {
        mode: "live",
        label: "Live Host",
        note: "Dashboard actions run against the configured Docker host."
      }
    };
  }

  async detectHost(input = null) {
    const savedSettings = await this.loadSettings();
    const draftSettings = input
      ? normalizeSettings({
          ...savedSettings,
          ...input,
          initialized: savedSettings.initialized
        })
      : savedSettings;

    return detectHostEnvironment(draftSettings);
  }

  async setup(input = {}) {
    const deploy = input?.deploy === true;
    const rawSettings = { ...input };
    delete rawSettings.deploy;

    const detection = await detectHostEnvironment(rawSettings);
    const settings = await saveSettings({
      ...detection.selected?.suggestedSettings,
      ...rawSettings,
      adapterType: rawSettings.adapterType || detection.selected?.adapterId || "generic-docker",
      hostLabel: rawSettings.hostLabel || detection.selected?.suggestedSettings?.hostLabel || "Docker Host"
    });

    const generated = await writeStacks(settings, settings.selectedServiceIds);
    await appendActivity({
      kind: "setup",
      level: "info",
      message: `Generated ${generated.length} stack folder(s).`
    });

    const deployResults = [];
    if (deploy) {
      for (const serviceId of settings.selectedServiceIds) {
        const service = this.requireService(settings, serviceId);
        const result = await generateAndDeploy(settings, service);
        const deployEntry = {
          serviceId,
          ok: result.ok,
          output: `${result.stdout}\n${result.stderr}`.trim()
        };
        deployResults.push(deployEntry);

        await appendActivity({
          kind: "deploy",
          level: result.ok ? "info" : "error",
          message: result.ok ? `Deployed ${service.name}.` : `Deploy failed for ${service.name}.`,
          details: deployEntry
        });
      }
    }

    const state = await this.buildState();
    return {
      ...state,
      generated,
      deployResults
    };
  }

  async scanImportInventory() {
    const settings = await this.loadSettings();
    return scanDockerInventory(settings);
  }

  async previewImport(containerId) {
    const settings = await this.loadSettings();
    const item = await this.findImportCandidate(settings, containerId);
    return buildImportPreview(settings, item);
  }

  async adoptImportAsDraft(containerId) {
    const settings = await this.loadSettings();
    if (!settings.initialized) {
      throw new StackarrError("Configure the host profile before adopting an existing container into a managed draft.", {
        statusCode: 400
      });
    }

    const item = await this.findImportCandidate(settings, containerId);
    const preview = await buildImportPreview(settings, item);

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
      : await saveSettings({
          ...settings,
          selectedServiceIds: nextSelectedServiceIds
        });

    const generated = await writeStacks(nextSettings, [item.serviceId]);
    await appendActivity({
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
      preview: await buildImportPreview(nextSettings, item),
      generated,
      state: await this.buildState()
    };
  }

  async generateServiceFiles(serviceId) {
    const settings = await this.loadSettings();
    const service = this.requireService(settings, serviceId);
    const generated = await writeStacks(settings, [service.id]);
    await appendActivity({
      kind: "generate",
      level: "info",
      message: `Regenerated stack files for ${service.name}.`
    });

    return {
      ok: true,
      generated
    };
  }

  async installManagedService(serviceId) {
    const settings = await this.loadSettings();
    const service = this.requireService(settings, serviceId);
    await writeStacks(settings, [service.id]);
    const result = await installService(settings, service);

    await appendActivity({
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

  async checkServiceUpdate(serviceId) {
    const settings = await this.loadSettings();
    const service = this.requireService(settings, serviceId);
    const result = await checkForUpdates(settings, service);
    const updateState = await readUpdateState();

    updateState[service.id] = {
      status: result.updateStatus,
      checkedAt: new Date().toISOString()
    };
    await writeUpdateState(updateState);

    await appendActivity({
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

  async upgradeManagedService(serviceId) {
    const settings = await this.loadSettings();
    const service = this.requireService(settings, serviceId);
    const result = await upgradeService(settings, service);

    await appendActivity({
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

  async checkAllUpdates() {
    const settings = await this.loadSettings();
    const nextState = await readUpdateState();
    const results = [];

    for (const serviceId of settings.selectedServiceIds) {
      const service = this.requireService(settings, serviceId);
      const result = await checkForUpdates(settings, service);
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

    await writeUpdateState(nextState);
    await appendActivity({
      kind: "update-check-all",
      level: "info",
      message: "Checked update status across the selected stack."
    });

    return {
      ok: true,
      results
    };
  }

  async upgradeAll() {
    const settings = await this.loadSettings();
    const services = settings.selectedServiceIds.map((serviceId) => this.requireService(settings, serviceId));
    const results = await upgradeAllServices(settings, services);
    const ok = results.every((result) => result.ok);

    await appendActivity({
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

  requireService(settings, serviceId) {
    const service = settings.services[serviceId];

    if (!service) {
      throw new StackarrError(`Unknown or disabled service: ${serviceId}`, {
        statusCode: 404
      });
    }

    return service;
  }

  async findImportCandidate(settings, containerId) {
    const inventory = await scanDockerInventory(settings);
    const item = inventory.items.find((candidate) => candidate.containerId === containerId);

    if (!item) {
      throw new StackarrError(`Unknown import candidate: ${containerId}`, {
        statusCode: 404
      });
    }

    return item;
  }
}
