import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHttpApp } from "./create-http-app.js";
import { DemoStackarrAppService } from "./lib/demo-service.js";
import { StackarrAppService } from "./lib/stackarr-app-service.js";

const port = Number(process.env.STACKARR_PORT || 4687);
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");
const stackarrApp = process.env.STACKARR_DEMO === "1"
  ? new DemoStackarrAppService()
  : new StackarrAppService();
const app = createHttpApp({
  publicDir,
  stackarrApp
});

app.listen(port, () => {
  console.log(`Stackarr listening on http://localhost:${port}`);
});
