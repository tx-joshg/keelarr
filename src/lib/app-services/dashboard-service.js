import { buildDashboardState } from "../status.js";
import { listServices } from "../service-catalog.js";

export class DashboardService {
  constructor({ hostProfileService } = {}) {
    this.hostProfileService = hostProfileService;
  }

  async buildState() {
    const { settings, hostDetection } = await this.hostProfileService.resolveStateSettings();
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
}
