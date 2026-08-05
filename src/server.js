import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHttpApp } from "./create-http-app.js";
import { DemoStackarrAppService } from "./lib/demo-service.js";
import { logPath } from "./lib/data-paths.js";
import { createLogger } from "./lib/logger.js";
import { StackarrAppService } from "./lib/stackarr-app-service.js";

const port = Number(process.env.STACKARR_PORT || 4687);
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");
const logger = createLogger({
  bindings: {
    app: "stackarr"
  }
});
const stackarrApp = process.env.STACKARR_DEMO === "1"
  ? new DemoStackarrAppService()
  : new StackarrAppService({
      logger
    });
const app = createHttpApp({
  publicDir,
  stackarrApp,
  logger
});

if (typeof stackarrApp.initialize === "function") {
  await stackarrApp.initialize();
}

app.listen(port, () => {
  logger.info("server.listen", {
    mode: process.env.STACKARR_DEMO === "1" ? "demo" : "live",
    port,
    url: `http://localhost:${port}`,
    logPath
  });
});
