import { access } from "node:fs/promises";

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
import { defaultLogger } from "../logger.js";

export class ManagedStackService {
  constructor({
    appendActivityImpl = appendActivity,
    checkForUpdatesImpl = checkForUpdates,
    generateAndDeployImpl = generateAndDeploy,
    hostProfileService = null,
    installServiceImpl = installService,
    loadSettingsImpl = loadSettings,
    logger = defaultLogger,
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
    this.logger = logger.child({
      component: "managed-stack-service"
    });
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

  scopedLogger(context = {}) {
    return context.requestId
      ? this.logger.child({ requestId: context.requestId })
      : this.logger;
  }

  /** A stack is deployable only once its compose file exists on disk. */
  async serviceIsDeployed(service) {
    try {
      await access(service.composePath);
      return true;
    } catch {
      return false;
    }
  }

  async deploySelected(settings, serviceIds = settings.selectedServiceIds, context = {}) {
    const logger = this.scopedLogger(context);
    const deployResults = [];

    for (const serviceId of serviceIds) {
      const service = this.requireService(settings, serviceId);
      const result = await this.generateAndDeploy(settings, service, {
        logger: logger.child({
          serviceId: service.id,
          containerName: service.containerName
        })
      });
      const deployEntry = {
        serviceId,
        ok: result.ok,
        output: `${result.stdout}\n${result.stderr}`.trim()
      };
      deployResults.push(deployEntry);

      logger[result.ok ? "info" : "error"]("service.deploy", {
        serviceId: service.id,
        serviceName: service.name,
        containerName: service.containerName,
        composePath: service.composePath,
        envPath: service.envPath,
        ok: result.ok,
        stdout: result.stdout,
        stderr: result.stderr
      });

      await this.appendActivity({
        kind: "deploy",
        level: result.ok ? "info" : "error",
        message: result.ok ? `Deployed ${service.name}.` : `Deploy failed for ${service.name}.`,
        details: deployEntry
      });
    }

    return deployResults;
  }

  async generateServiceFiles(serviceId, context = {}) {
    const settings = await this.loadSettings();
    const service = this.requireService(settings, serviceId);
    const generated = await this.writeStacks(settings, [service.id]);
    this.scopedLogger(context).info("service.generate", {
      serviceId: service.id,
      serviceName: service.name,
      composePath: service.composePath,
      envPath: service.envPath
    });
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

  async installManagedService(serviceId, context = {}) {
    const settings = await this.loadSettings();
    const service = this.requireService(settings, serviceId);
    const logger = this.scopedLogger(context);
    await this.writeStacks(settings, [service.id]);
    const result = await this.installService(settings, service, {
      logger: logger.child({
        serviceId: service.id,
        containerName: service.containerName
      })
    });

    logger[result.ok ? "info" : "error"]("service.install", {
      serviceId: service.id,
      serviceName: service.name,
      containerName: service.containerName,
      ok: result.ok,
      stdout: result.stdout,
      stderr: result.stderr
    });

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

  async checkServiceUpdate(serviceId, context = {}) {
    const settings = await this.loadSettings();
    const service = this.requireService(settings, serviceId);
    const logger = this.scopedLogger(context);
    const result = await this.checkForUpdates(settings, service, {
      logger: logger.child({
        serviceId: service.id,
        containerName: service.containerName
      })
    });
    const updateState = await this.readUpdateState();

    updateState[service.id] = {
      status: result.updateStatus,
      checkedAt: new Date().toISOString()
    };
    await this.writeUpdateState(updateState);

    logger[result.ok ? "info" : "warn"]("service.update_check", {
      serviceId: service.id,
      serviceName: service.name,
      containerName: service.containerName,
      ok: result.ok,
      updateStatus: result.updateStatus,
      stdout: result.stdout,
      stderr: result.stderr
    });

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

  async upgradeManagedService(serviceId, context = {}) {
    const settings = await this.loadSettings();
    const service = this.requireService(settings, serviceId);
    const logger = this.scopedLogger(context);
    const result = await this.upgradeService(settings, service, {
      logger: logger.child({
        serviceId: service.id,
        containerName: service.containerName
      })
    });

    logger[result.ok ? "info" : "error"]("service.upgrade", {
      serviceId: service.id,
      serviceName: service.name,
      containerName: service.containerName,
      ok: result.ok,
      stdout: result.stdout,
      stderr: result.stderr
    });

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

  async checkAllUpdates(context = {}) {
    const settings = await this.loadSettings();
    const nextState = await this.readUpdateState();
    const results = [];
    const logger = this.scopedLogger(context);

    for (const serviceId of settings.selectedServiceIds) {
      const service = this.requireService(settings, serviceId);

      // A service that was never deployed has no compose file to pull against.
      // Reporting that as a failure makes a healthy stack look broken.
      if (!(await this.serviceIsDeployed(service))) {
        results.push({
          serviceId: service.id,
          ok: true,
          skipped: true,
          updateStatus: "not-deployed"
        });
        continue;
      }

      const result = await this.checkForUpdates(settings, service, {
        logger: logger.child({
          serviceId: service.id,
          containerName: service.containerName
        })
      });
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
    logger.info("service.update_check_all", {
      results
    });
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

  async upgradeAll(context = {}) {
    const settings = await this.loadSettings();
    const services = settings.selectedServiceIds.map((serviceId) => this.requireService(settings, serviceId));
    const logger = this.scopedLogger(context);
    const results = await this.upgradeAllServices(settings, services, {
      logger
    });
    const ok = results.every((result) => result.ok);

    logger[ok ? "info" : "error"]("service.upgrade_all", {
      ok,
      results
    });

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
