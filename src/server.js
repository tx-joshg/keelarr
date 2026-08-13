import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHttpApp } from "./create-http-app.js";
import { DemoKeelarrAppService } from "./lib/demo-service.js";
import { logPath } from "./lib/data-paths.js";
import { createLogger } from "./lib/logger.js";
import { KeelarrAppService } from "./lib/keelarr-app-service.js";

const port = Number(process.env.KEELARR_PORT || 4687);
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");
const logger = createLogger({
  bindings: {
    app: "keelarr"
  }
});
const demoMode = process.env.KEELARR_DEMO === "1";
const keelarrApp = demoMode
  ? new DemoKeelarrAppService()
  : new KeelarrAppService({
      logger
    });
const app = createHttpApp({
  publicDir,
  keelarrApp,
  logger,
  // The demo runs against a simulated stack with no Docker socket behind it,
  // so there is nothing for a password to protect and it would only stand
  // between a visitor and a look around.
  requireAuth: !demoMode
});

/**
 * Listen first, then do the startup work.
 *
 * Initialisation inspects every container and attaches the controller to each
 * service network, which took four minutes on a busy NAS. Doing that before
 * binding the port meant nothing answered until it finished — so the container
 * healthcheck, which allows twenty seconds and three retries, marked a
 * perfectly healthy controller unhealthy. On a host that restarts unhealthy
 * containers that is not a cosmetic problem: it is a loop, killing the
 * controller mid-startup every time.
 *
 * /api/health only claims the process is answering, which is true the moment
 * the port is open, so it is honest to serve it before the rest is ready.
 */
app.listen(port, () => {
  logger.info("server.listen", {
    mode: demoMode ? "demo" : "live",
    port,
    url: `http://localhost:${port}`,
    logPath
  });
});

if (typeof keelarrApp.initialize === "function") {
  const startedAt = Date.now();

  try {
    await keelarrApp.initialize();
    logger.info("server.ready", { tookMs: Date.now() - startedAt });
  } catch (error) {
    // A controller that cannot re-attach to a network is still worth having:
    // the dashboard, the logs and the recovery actions all still work, and
    // exiting here would take those away exactly when they are needed.
    logger.error("server.initialize_failed", {
      tookMs: Date.now() - startedAt,
      message: error.message
    });
  }
}
