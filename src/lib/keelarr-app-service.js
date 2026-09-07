import { CutoverService } from "./app-services/cutover-service.js";
import { SelfUpdateService } from "./app-services/self-update-service.js";
import { MutationLease } from "./mutation-lease.js";
import { DashboardService } from "./app-services/dashboard-service.js";
import { HostProfileService } from "./app-services/host-profile-service.js";
import { ImportService } from "./app-services/import-service.js";
import { ManagedStackService } from "./app-services/managed-stack-service.js";
import { RemovalService } from "./app-services/removal-service.js";
import { WiringService } from "./app-services/wiring-service.js";
import { buildJobSnapshot } from "./jobs.js";

export class KeelarrAppService {
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
    // One claim shared by everything that mutates the stack, so a cutover
    // cannot start in the gap between checking that an update is safe and the
    // controller being replaced.
    this.mutationLease = new MutationLease();
    // The scheduler stands aside while the controller is replacing itself.
    this.managedStackService.lease = this.mutationLease;
    this.selfUpdateService = new SelfUpdateService({
      hostProfileService: this.hostProfileService,
      jobs: this.cutoverService.jobs,
      lease: this.mutationLease,
      logger
    });
    this.dashboardService.managedStackService = this.managedStackService;
    this.dashboardService.selfUpdateService = this.selfUpdateService;
  }

  /**
   * Restores persisted jobs before the server accepts traffic, so a job
   * interrupted by a restart is reported rather than silently forgotten.
   */
  async initialize() {
    await this.cutoverService.jobs.hydrate();
    // Before the network attach, which has taken minutes on a NAS: someone who
    // just watched Keelarr restart is owed the answer promptly, and a failure
    // here must not skip the attach.
    await this.selfUpdateService.reconcile().catch(() => {});
    // Re-derived on every start, because the controller's network attachments
    // live on the container rather than in a Compose file and are lost whenever
    // it is recreated.
    await this.wiringService.attachToServiceNetworks();
    // Daily, and shortly after start if the last one is older than that. This
    // is the only thing that checks on its own: an upgrade uses what the last
    // check recorded rather than pulling every image again to find out.
    this.stopUpdateSchedule = this.managedStackService.startUpdateSchedule();
    this.stopAutoUpdateSchedule = this.managedStackService.startAutoUpdateSchedule();
  }

  async shutdown() {
    this.stopUpdateSchedule?.();
    this.stopAutoUpdateSchedule?.();
  }

  async describeSelfUpdate(context = {}) {
    return { ok: true, selfUpdate: await this.selfUpdateService.describeSelfUpdate(context) };
  }

  async checkSelfUpdate(context = {}) {
    return { ok: true, selfUpdate: await this.selfUpdateService.checkSelfUpdate(context) };
  }

  async startSelfUpdate(input = {}, context = {}) {
    return { ok: true, job: buildJobSnapshot(this.selfUpdateService.startSelfUpdate(input, context)) };
  }

  async dismissSelfUpdateNotice() {
    return this.selfUpdateService.dismissNotice();
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
      validation,
      controllerEnv
    } = await this.hostProfileService.saveProfile(input, context);
    const state = await this.dashboardService.buildState();

    return {
      ...state,
      generated: [],
      hostDetection: detection,
      validation,
      // Whether the controller's own env file could be brought into line, so
      // the UI can say a restart is needed rather than leaving it to be found.
      controllerEnv,
      effectiveSettings,
      settings
    };
  }

  async setup(input = {}, context = {}) {
    if (input?.deploy === true) {
      this.mutationLease.assertAvailable("Deploying the stack");
    }

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
    // First-run setup ends connected too, not just individual installs.
    const wiringJob = deploy && deployResults.some((result) => result?.ok)
      ? await this.startPostDeployWiring(context)
      : null;
    const state = await this.dashboardService.buildState();

    return {
      ...state,
      generated,
      deployResults,
      wiringJob,
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
    // Refused while the controller is replacing itself: it is about to stop
    // the process running this, which would leave it half-finished.
    this.mutationLease.assertAvailable("A cutover");
    return {
      ok: true,
      job: buildJobSnapshot(this.cutoverService.startCutover(containerId, input, context))
    };
  }

  async startCutoverRevert(serviceId, input = {}, context = {}) {
    // Takes the managed container down and renames the original back. Never
    // checked the lease before: it was reachable underneath a controller
    // update, and underneath a scheduled upgrade of the same app.
    this.mutationLease.assertAvailable("A cutover revert");
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

  /**
   * Installs a service and then connects it, so a one-click install finishes
   * with a working app rather than a to-do. The wiring runs as its own job the
   * caller can watch, because it waits for the new app to finish starting and
   * that is not something an install request should block on.
   */
  async installManagedService(serviceId, context = {}) {
    // Refused while the controller is replacing itself: it is about to stop
    // the process running this, which would leave it half-finished.
    this.mutationLease.assertAvailable("Installing an app");
    const result = await this.managedStackService.installManagedService(serviceId, context);

    return {
      ...result,
      wiringJob: result.ok ? await this.startPostDeployWiring(context) : null
    };
  }

  /**
   * Connects whatever is now deployed. Returns null rather than throwing when
   * there is nothing to do: a service installed into an already-wired stack is
   * a success, not a failure, and the 409 that says so is not worth surfacing.
   */
  async startPostDeployWiring(context = {}) {
    try {
      // Reach first. A service deployed onto a network the controller is not on
      // yet cannot be configured, however correct the plan is.
      await this.wiringService.attachToServiceNetworks(context);
      return buildJobSnapshot(this.wiringService.startWiring({}, context));
    } catch (error) {
      if (error.statusCode === 409) {
        return null;
      }

      throw error;
    }
  }

  async restartManagedService(serviceId, context = {}) {
    this.mutationLease.assertAvailable("Restarting an app");
    return this.managedStackService.restartManagedService(serviceId, context);
  }

  async checkServiceUpdate(serviceId, context = {}) {
    return this.managedStackService.checkServiceUpdate(serviceId, context);
  }

  async upgradeManagedService(serviceId, context = {}) {
    // Refused while the controller is replacing itself: it is about to stop
    // the process running this, which would leave it half-finished.
    this.mutationLease.assertAvailable("Upgrading an app");
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
    // Refused while the controller is replacing itself: it is about to stop
    // the process running this, which would leave it half-finished.
    this.mutationLease.assertAvailable("Removing an app");
    return {
      ok: true,
      job: buildJobSnapshot(this.removalService.startRemoval(serviceId, input, context))
    };
  }

  async startRollback(serviceId, input = {}, context = {}) {
    // Refused while the controller is replacing itself: it is about to stop
    // the process running this, which would leave it half-finished.
    this.mutationLease.assertAvailable("A rollback");
    return {
      ok: true,
      job: buildJobSnapshot(this.managedStackService.startRollback(serviceId, input, context))
    };
  }

  async checkAllUpdates(context = {}) {
    return this.managedStackService.checkAllUpdates(context);
  }

  async describeAutoUpdate() {
    return { ok: true, autoUpdate: await this.managedStackService.describeAutoUpdate() };
  }

  async setServiceAutoUpdate(serviceId, input = {}, context = {}) {
    const settings = await this.loadSettings();
    const service = this.managedStackService.requireService(settings, serviceId);
    const enabled = input?.enabled === true;

    await this.hostProfileService.patchServiceOverride(serviceId, { autoUpdate: enabled });
    await this.managedStackService.appendActivity({
      kind: "settings-save",
      level: "info",
      message: `Auto-update ${enabled ? "on" : "off"} for ${service.name}.`,
      details: { serviceId, autoUpdate: enabled }
    });

    return { ok: true, serviceId, autoUpdate: enabled };
  }

  /** Runs the scheduled job now. Does not claim tonight's window. */
  async runAutoUpdateNow(context = {}) {
    this.mutationLease.assertAvailable("A scheduled update");
    const settings = await this.loadSettings();
    const optedIn = settings.selectedServiceIds
      .map((serviceId) => settings.services[serviceId])
      .filter((service) => service && service.autoUpdate === true);

    if (optedIn.length === 0) {
      return { ok: true, job: null, message: "No app has auto-update turned on." };
    }

    return {
      ok: true,
      job: buildJobSnapshot(this.managedStackService.startAutoUpdate(settings, optedIn, { ...context, trigger: "manual" }))
    };
  }

  async upgradeAll(input = {}, context = {}) {
    // Refused while the controller is replacing itself: it is about to stop
    // the process running this, which would leave it half-finished.
    this.mutationLease.assertAvailable("Upgrading every app");
    const started = await this.managedStackService.startUpgradeAll(input, context).create();

    // Nothing to upgrade means no job was created, so there is no progress to
    // follow — just the answer.
    if (started && started.job === null) {
      return started;
    }

    return {
      ok: true,
      job: buildJobSnapshot(started)
    };
  }
}
