import { buildDashboardState } from "../status.js";
import { listServices } from "../service-catalog.js";
import { APP_NAME, APP_VERSION } from "../app-meta.js";

export class DashboardService {
  constructor({ hostProfileService, managedStackService = null } = {}) {
    this.hostProfileService = hostProfileService;
    this.managedStackService = managedStackService;
  }

  /**
   * Annotates each service with the image it could roll back to, so the
   * dashboard only offers the action when a usable backup actually exists.
   */
  async withRollbackPoints(settings, services) {
    if (!this.managedStackService) {
      return services;
    }

    return Promise.all(services.map(async (service) => ({
      ...service,
      rollbackPoint: await this.managedStackService
        .describeRollbackPoint(settings, service)
        .catch(() => null)
    })));
  }

  async buildState() {
    const { settings, hostDetection } = await this.hostProfileService.resolveStateSettings();
    const state = await buildDashboardState(settings);
    state.services = await this.withRollbackPoints(settings, state.services);

    return {
      ok: true,
      ...state,
      catalog: listServices(),
      hostDetection,
      meta: {
        appName: APP_NAME,
        version: APP_VERSION,
        mode: "live",
        label: "Live Host",
        note: "Dashboard actions run against the configured Docker host."
      }
    };
  }
}
