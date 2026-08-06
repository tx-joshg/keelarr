import { CutoverService } from "./app-services/cutover-service.js";
import { DashboardService } from "./app-services/dashboard-service.js";
import { HostProfileService } from "./app-services/host-profile-service.js";
import { ImportService } from "./app-services/import-service.js";
import { ManagedStackService } from "./app-services/managed-stack-service.js";
import { RemovalService } from "./app-services/removal-service.js";
import { WiringService } from "./app-services/wiring-service.js";
import { buildJobSnapshot } from "./jobs.js";

export class StackarrAppService {
  constructor({
    cutoverService = null,
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
    this.cutoverService = cutoverService || new CutoverService({
      hostProfileService: this.hostProfileService,
      logger
    });
    this.removalService = new RemovalService({
      hostProfileService: this.hostProfileService,
      logger
    });
    this.wiringService = new WiringService({
      hostProfileService: this.hostProfileService,
      logger
    });
    // One registry across all services so /api/jobs shows every job kind.
    this.managedStackService.jobs = this.cutoverService.jobs;
    this.removalService.jobs = this.cutoverService.jobs;
    this.wiringService.jobs = this.cutoverService.jobs;
    this.dashboardService.managedStackService = this.managedStackService;
  }

  /**
   * Restores persisted jobs before the server accepts traffic, so a job
   * interrupted by a restart is reported rather than silently forgotten.
   */
  async initialize() {
    await this.cutoverService.jobs.hydrate();
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

  async saveSettings(input = {}, context = {}) {
    const {
      settings,
      detection,
      effectiveSettings,
      validation
    } = await this.hostProfileService.saveProfile(input, context);
    const state = await this.dashboardService.buildState();

    return {
      ...state,
      generated: [],
      hostDetection: detection,
      validation,
      effectiveSettings,
      settings
    };
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

  async browseDirectories(inputPath = "/", context = {}) {
    return this.hostProfileService.browseDirectories(inputPath, context);
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

  /**
   * Returns as soon as the job is registered. Cutover is destructive and can
   * outlive a request, so progress is polled rather than streamed back on the
   * connection that started it.
   */
  async startCutover(containerId, input = {}, context = {}) {
    return {
      ok: true,
      job: buildJobSnapshot(this.cutoverService.startCutover(containerId, input, context))
    };
  }

  async startCutoverRevert(serviceId, input = {}, context = {}) {
    return {
      ok: true,
      job: buildJobSnapshot(this.cutoverService.startRevert(serviceId, input, context))
    };
  }

  async getJob(jobId) {
    return {
      ok: true,
      job: buildJobSnapshot(this.cutoverService.getJob(jobId))
    };
  }

  async listJobs() {
    return {
      ok: true,
      jobs: this.cutoverService.listJobs().map((job) => buildJobSnapshot(job))
    };
  }

  async generateServiceFiles(serviceId, context = {}) {
    return this.managedStackService.generateServiceFiles(serviceId, context);
  }

  async installManagedService(serviceId, context = {}) {
    return this.managedStackService.installManagedService(serviceId, context);
  }

  async restartManagedService(serviceId, context = {}) {
    return this.managedStackService.restartManagedService(serviceId, context);
  }

  async checkServiceUpdate(serviceId, context = {}) {
    return this.managedStackService.checkServiceUpdate(serviceId, context);
  }

  async upgradeManagedService(serviceId, context = {}) {
    return this.managedStackService.upgradeManagedService(serviceId, context);
  }

  async describeWiring(context = {}) {
    return this.wiringService.describeWiring(context);
  }

  async startWiring(input = {}, context = {}) {
    return {
      ok: true,
      job: buildJobSnapshot(this.wiringService.startWiring(input, context))
    };
  }

  async describeRemoval(serviceId, context = {}) {
    return this.removalService.describeRemoval(serviceId, context);
  }

  async startRemoval(serviceId, input = {}, context = {}) {
    return {
      ok: true,
      job: buildJobSnapshot(this.removalService.startRemoval(serviceId, input, context))
    };
  }

  async startRollback(serviceId, input = {}, context = {}) {
    return {
      ok: true,
      job: buildJobSnapshot(this.managedStackService.startRollback(serviceId, input, context))
    };
  }

  async checkAllUpdates(context = {}) {
    return this.managedStackService.checkAllUpdates(context);
  }

  async upgradeAll(input = {}, context = {}) {
    const job = await this.managedStackService.startUpgradeAll(input, context).create();

    return {
      ok: true,
      job: buildJobSnapshot(job)
    };
  }
}
