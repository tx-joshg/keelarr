import { DashboardService } from "./app-services/dashboard-service.js";
import { HostProfileService } from "./app-services/host-profile-service.js";
import { ImportService } from "./app-services/import-service.js";
import { ManagedStackService } from "./app-services/managed-stack-service.js";

export class StackarrAppService {
  constructor({
    dashboardService = null,
    hostProfileService = null,
    importService = null,
    logger = null,
    managedStackService = null
  } = {}) {
    this.hostProfileService = hostProfileService || new HostProfileService({
      logger
    });
    this.dashboardService = dashboardService || new DashboardService({
      hostProfileService: this.hostProfileService
    });
    this.importService = importService || new ImportService({
      hostProfileService: this.hostProfileService,
      logger
    });
    this.managedStackService = managedStackService || new ManagedStackService({
      hostProfileService: this.hostProfileService,
      logger
    });
  }

  async loadSettings() {
    return this.hostProfileService.loadSettings();
  }

  async resolveStateSettings() {
    return this.hostProfileService.resolveStateSettings();
  }

  async buildState() {
    return this.dashboardService.buildState();
  }

  async detectHost(input = null, context = {}) {
    return this.hostProfileService.detectHost(input, context);
  }

  async setup(input = {}, context = {}) {
    const {
      settings,
      generated,
      detection,
      effectiveSettings,
      validation,
      deploy
    } = await this.hostProfileService.prepareSetup(input, context);
    const deployResults = deploy
      ? await this.managedStackService.deploySelected(settings, settings.selectedServiceIds, context)
      : [];
    const state = await this.dashboardService.buildState();

    return {
      ...state,
      generated,
      deployResults,
      hostDetection: detection,
      validation,
      effectiveSettings
    };
  }

  async scanImportInventory(context = {}) {
    return this.importService.scanImportInventory(context);
  }

  async previewImport(containerId, context = {}) {
    return this.importService.previewImport(containerId, context);
  }

  async adoptImportAsDraft(containerId, context = {}) {
    const result = await this.importService.adoptImportAsDraft(containerId, context);

    return {
      ...result,
      state: await this.buildState()
    };
  }

  async generateServiceFiles(serviceId, context = {}) {
    return this.managedStackService.generateServiceFiles(serviceId, context);
  }

  async installManagedService(serviceId, context = {}) {
    return this.managedStackService.installManagedService(serviceId, context);
  }

  async checkServiceUpdate(serviceId, context = {}) {
    return this.managedStackService.checkServiceUpdate(serviceId, context);
  }

  async upgradeManagedService(serviceId, context = {}) {
    return this.managedStackService.upgradeManagedService(serviceId, context);
  }

  async checkAllUpdates(context = {}) {
    return this.managedStackService.checkAllUpdates(context);
  }

  async upgradeAll(context = {}) {
    return this.managedStackService.upgradeAll(context);
  }
}
