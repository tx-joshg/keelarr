import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DemoStackarrAppService } from "./lib/demo-service.js";
import { StackarrAppService } from "./lib/stackarr-app-service.js";

const app = express();
const port = Number(process.env.STACKARR_PORT || 4687);
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");
const stackarrApp = process.env.STACKARR_DEMO === "1"
  ? new DemoStackarrAppService()
  : new StackarrAppService();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir));

app.get("/api/state", async (_request, response, next) => {
  try {
    response.json(await stackarrApp.buildState());
  } catch (error) {
    next(error);
  }
});

app.get("/api/host/detect", async (_request, response, next) => {
  try {
    response.json({
      ok: true,
      ...(await stackarrApp.detectHost())
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/host/detect", async (request, response, next) => {
  try {
    response.json({
      ok: true,
      ...(await stackarrApp.detectHost(request.body || {}))
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/setup", async (request, response, next) => {
  try {
    response.json(await stackarrApp.setup(request.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/import/scan", async (_request, response, next) => {
  try {
    response.json(await stackarrApp.scanImportInventory());
  } catch (error) {
    next(error);
  }
});

app.get("/api/import/:containerId/preview", async (request, response, next) => {
  try {
    response.json(await stackarrApp.previewImport(request.params.containerId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/import/:containerId/adopt-draft", async (request, response, next) => {
  try {
    response.json(await stackarrApp.adoptImportAsDraft(request.params.containerId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/demo/reset", async (_request, response, next) => {
  try {
    if (typeof stackarrApp.resetDemo !== "function") {
      response.status(404).json({
        ok: false,
        error: "Demo mode is not enabled."
      });
      return;
    }

    response.json(await stackarrApp.resetDemo());
  } catch (error) {
    next(error);
  }
});

app.post("/api/services/:serviceId/generate", async (request, response, next) => {
  try {
    response.json(await stackarrApp.generateServiceFiles(request.params.serviceId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/services/:serviceId/install", async (request, response, next) => {
  try {
    response.json(await stackarrApp.installManagedService(request.params.serviceId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/services/:serviceId/check-update", async (request, response, next) => {
  try {
    response.json(await stackarrApp.checkServiceUpdate(request.params.serviceId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/services/:serviceId/upgrade", async (request, response, next) => {
  try {
    response.json(await stackarrApp.upgradeManagedService(request.params.serviceId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/services/check-all", async (_request, response, next) => {
  try {
    response.json(await stackarrApp.checkAllUpdates());
  } catch (error) {
    next(error);
  }
});

app.post("/api/services/upgrade-all", async (_request, response, next) => {
  try {
    response.json(await stackarrApp.upgradeAll());
  } catch (error) {
    next(error);
  }
});

app.get("/demo/apps/:serviceId", async (request, response, next) => {
  try {
    if (typeof stackarrApp.renderDemoAppPage !== "function") {
      response.status(404).send("Demo mode is not enabled.");
      return;
    }

    const page = await stackarrApp.renderDemoAppPage(request.params.serviceId);
    if (!page) {
      response.status(404).send("Unknown demo app.");
      return;
    }

    response.type("html").send(page);
  } catch (error) {
    next(error);
  }
});

app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(publicDir, "index.html"));
});

app.use((error, _request, response, _next) => {
  response.status(error.statusCode || 500).json({
    ok: false,
    error: error.message || "Unexpected server error."
  });
});

app.listen(port, () => {
  console.log(`Stackarr listening on http://localhost:${port}`);
});
