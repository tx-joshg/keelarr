import { DashboardService } from "./app-services/dashboard-service.js";
import { HostProfileService } from "./app-services/host-profile-service.js";
import { ImportService } from "./app-services/import-service.js";
import { ManagedStackService } from "./app-services/managed-stack-service.js";

export class StackarrAppService {
  constructor({
    dashboardService = null,
    hostProfileService = null,
    importService = null,
    managedStackService = null
  } = {}) {
    this.hostProfileService = hostProfileService || new HostProfileService();
    this.dashboardService = dashboardService || new DashboardService({
      hostProfileService: this.hostProfileService
    });
    this.importService = importService || new ImportService({
      hostProfileService: this.hostProfileService
    });
    this.managedStackService = managedStackService || new ManagedStackService({
      hostProfileService: this.hostProfileService
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

  async detectHost(input = null) {
    return this.hostProfileService.detectHost(input);
  }

  async setup(input = {}) {
    const {
      settings,
      generated,
      detection,
      effectiveSettings,
      validation,
      deploy
    } = await this.hostProfileService.prepareSetup(input);
    const deployResults = deploy
      ? await this.managedStackService.deploySelected(settings)
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

  async scanImportInventory() {
    return this.importService.scanImportInventory();
  }

  async previewImport(containerId) {
    return this.importService.previewImport(containerId);
  }

  async adoptImportAsDraft(containerId) {
    const result = await this.importService.adoptImportAsDraft(containerId);

    return {
      ...result,
      state: await this.buildState()
    };
  }

  async generateServiceFiles(serviceId) {
    return this.managedStackService.generateServiceFiles(serviceId);
  }

  async installManagedService(serviceId) {
    return this.managedStackService.installManagedService(serviceId);
  }

  async checkServiceUpdate(serviceId) {
    return this.managedStackService.checkServiceUpdate(serviceId);
  }

  async upgradeManagedService(serviceId) {
    return this.managedStackService.upgradeManagedService(serviceId);
  }

  async checkAllUpdates() {
    return this.managedStackService.checkAllUpdates();
  }

  async upgradeAll() {
    return this.managedStackService.upgradeAll();
  }
}
