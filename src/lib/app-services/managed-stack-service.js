import { writeStacks } from "../generator.js";
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

export class ManagedStackService {
  constructor({
    appendActivityImpl = appendActivity,
    checkForUpdatesImpl = checkForUpdates,
    generateAndDeployImpl = generateAndDeploy,
    hostProfileService = null,
    installServiceImpl = installService,
    loadSettingsImpl = loadSettings,
    readUpdateStateImpl = readUpdateState,
    upgradeAllServicesImpl = upgradeAllServices,
    upgradeServiceImpl = upgradeService,
    writeStacksImpl = writeStacks,
    writeUpdateStateImpl = writeUpdateState
  } = {}) {
    this.appendActivity = appendActivityImpl;
    this.checkForUpdates = checkForUpdatesImpl;
    this.generateAndDeploy = generateAndDeployImpl;
    this.hostProfileService = hostProfileService;
    this.installService = installServiceImpl;
    this.loadSettingsImpl = loadSettingsImpl;
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

  async deploySelected(settings, serviceIds = settings.selectedServiceIds) {
    const deployResults = [];

    for (const serviceId of serviceIds) {
      const service = this.requireService(settings, serviceId);
      const result = await this.generateAndDeploy(settings, service);
      const deployEntry = {
        serviceId,
        ok: result.ok,
        output: `${result.stdout}\n${result.stderr}`.trim()
      };
      deployResults.push(deployEntry);

      await this.appendActivity({
        kind: "deploy",
        level: result.ok ? "info" : "error",
        message: result.ok ? `Deployed ${service.name}.` : `Deploy failed for ${service.name}.`,
        details: deployEntry
      });
    }

    return deployResults;
  }

  async generateServiceFiles(serviceId) {
    const settings = await this.loadSettings();
    const service = this.requireService(settings, serviceId);
    const generated = await this.writeStacks(settings, [service.id]);
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

  async installManagedService(serviceId) {
    const settings = await this.loadSettings();
    const service = this.requireService(settings, serviceId);
    await this.writeStacks(settings, [service.id]);
    const result = await this.installService(settings, service);

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

  async checkServiceUpdate(serviceId) {
    const settings = await this.loadSettings();
    const service = this.requireService(settings, serviceId);
    const result = await this.checkForUpdates(settings, service);
    const updateState = await this.readUpdateState();

    updateState[service.id] = {
      status: result.updateStatus,
      checkedAt: new Date().toISOString()
    };
    await this.writeUpdateState(updateState);

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

  async upgradeManagedService(serviceId) {
    const settings = await this.loadSettings();
    const service = this.requireService(settings, serviceId);
    const result = await this.upgradeService(settings, service);

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

  async checkAllUpdates() {
    const settings = await this.loadSettings();
    const nextState = await this.readUpdateState();
    const results = [];

    for (const serviceId of settings.selectedServiceIds) {
      const service = this.requireService(settings, serviceId);
      const result = await this.checkForUpdates(settings, service);
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

  async upgradeAll() {
    const settings = await this.loadSettings();
    const services = settings.selectedServiceIds.map((serviceId) => this.requireService(settings, serviceId));
    const results = await this.upgradeAllServices(settings, services);
    const ok = results.every((result) => result.ok);

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
