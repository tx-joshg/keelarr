import express from "express";
import path from "node:path";

function logLevelForStatus(statusCode) {
  if (statusCode >= 500) {
    return "error";
  }

  if (statusCode >= 400) {
    return "warn";
  }

  return "info";
}

function requestContext(request) {
  return {
    requestId: request.requestId
  };
}

export function createHttpApp({ publicDir, stackarrApp, logger = null }) {
  const app = express();
  const appLogger = logger?.child ? logger.child({
    component: "http"
  }) : null;

  app.use((request, response, next) => {
    const startedAt = process.hrtime.bigint();
    request.requestId = crypto.randomUUID();
    response.setHeader("x-request-id", request.requestId);

    response.on("finish", () => {
      if (!appLogger) {
        return;
      }

      const shouldLog = request.path.startsWith("/api") || request.path.startsWith("/demo") || response.statusCode >= 400;
      if (!shouldLog) {
        return;
      }

      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      appLogger[logLevelForStatus(response.statusCode)]("http.request", {
        requestId: request.requestId,
        method: request.method,
        path: request.originalUrl,
        statusCode: response.statusCode,
        durationMs: Math.round(durationMs * 100) / 100
      });
    });

    next();
  });

  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(publicDir));

  app.get("/api/state", async (request, response, next) => {
    try {
      response.json(await stackarrApp.buildState(requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/host/detect", async (request, response, next) => {
    try {
      response.json({
        ok: true,
        ...(await stackarrApp.detectHost(null, requestContext(request)))
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/host/detect", async (request, response, next) => {
    try {
      response.json({
        ok: true,
        ...(await stackarrApp.detectHost(request.body || {}, requestContext(request)))
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/settings", async (request, response, next) => {
    try {
      response.json(await stackarrApp.saveSettings(request.body || {}, requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/setup", async (request, response, next) => {
    try {
      response.json(await stackarrApp.setup(request.body || {}, requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/host/browse", async (request, response, next) => {
    try {
      response.json(await stackarrApp.browseDirectories(request.query.path || "/", requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/import/scan", async (request, response, next) => {
    try {
      response.json(await stackarrApp.scanImportInventory(requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/import/:containerId/preview", async (request, response, next) => {
    try {
      response.json(await stackarrApp.previewImport(request.params.containerId, requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/import/:containerId/adopt-draft", async (request, response, next) => {
    try {
      response.json(await stackarrApp.adoptImportAsDraft(request.params.containerId, requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/import/:containerId/cutover", async (request, response, next) => {
    try {
      // 202: the job is registered, not finished. Poll /api/jobs/:jobId.
      response.status(202).json(
        await stackarrApp.startCutover(request.params.containerId, request.body || {}, requestContext(request))
      );
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/services/:serviceId/revert-cutover", async (request, response, next) => {
    try {
      response.status(202).json(
        await stackarrApp.startCutoverRevert(request.params.serviceId, request.body || {}, requestContext(request))
      );
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/services/:serviceId/rollback", async (request, response, next) => {
    try {
      response.status(202).json(
        await stackarrApp.startRollback(request.params.serviceId, request.body || {}, requestContext(request))
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/jobs", async (_request, response, next) => {
    try {
      response.json(await stackarrApp.listJobs());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/jobs/:jobId", async (request, response, next) => {
    try {
      response.json(await stackarrApp.getJob(request.params.jobId));
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
      response.json(await stackarrApp.generateServiceFiles(request.params.serviceId, requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/services/:serviceId/install", async (request, response, next) => {
    try {
      response.json(await stackarrApp.installManagedService(request.params.serviceId, requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/services/:serviceId/check-update", async (request, response, next) => {
    try {
      response.json(await stackarrApp.checkServiceUpdate(request.params.serviceId, requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/services/:serviceId/upgrade", async (request, response, next) => {
    try {
      response.json(await stackarrApp.upgradeManagedService(request.params.serviceId, requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/services/check-all", async (request, response, next) => {
    try {
      response.json(await stackarrApp.checkAllUpdates(requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/services/upgrade-all", async (request, response, next) => {
    try {
      response.status(202).json(await stackarrApp.upgradeAll(request.body || {}, requestContext(request)));
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

  app.use((error, request, response, _next) => {
    appLogger?.error("http.error", {
      requestId: request.requestId || null,
      method: request.method,
      path: request.originalUrl,
      statusCode: error.statusCode || 500,
      message: error.message || "Unexpected server error.",
      details: error.details || null,
      stack: error.stack || null
    });
    response.status(error.statusCode || 500).json({
      ok: false,
      error: error.message || "Unexpected server error.",
      details: error.details || null
    });
  });

  return app;
}
