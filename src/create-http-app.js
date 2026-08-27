import express from "express";
import path from "node:path";
import { randomBytes } from "node:crypto";

import {
  MIN_PASSWORD_LENGTH,
  SESSION_COOKIE,
  buildLogoutCookie,
  buildSessionCookie,
  createSessionToken,
  hashPassword,
  readCookie,
  verifyPassword,
  verifySessionToken
} from "./lib/auth.js";
import { readAuth, writeAuth } from "./lib/store.js";

class KeelarrHttpError extends Error {
  constructor(message, statusCode, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

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

export function createHttpApp({
  publicDir,
  keelarrApp,
  logger = null,
  readAuthImpl = readAuth,
  writeAuthImpl = writeAuth,
  // Demo mode is a public sandbox against a simulated stack. There is no Docker
  // socket behind it and nothing to protect, so a password would only be a
  // barrier to looking around.
  requireAuth = true
} = {}) {
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

  /**
   * Reports liveness without a password.
   *
   * The container healthcheck used /api/state, which is now behind the gate —
   * leaving it there would mark every authenticated deployment unhealthy. This
   * says only that the process is answering, which is all a healthcheck needs
   * and all an unauthenticated caller should learn.
   */
  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  /**
   * Answers before the gate, because the page needs it in order to know which
   * screen to draw — first-run setup, login, or the dashboard.
   */
  app.get("/api/auth/status", async (request, response, next) => {
    try {
      const record = await readAuthImpl();
      const configured = Boolean(record?.hash);

      response.json({
        ok: true,
        required: requireAuth,
        // Distinguishes "no password has ever been set" from "you are signed
        // out": the first needs a setup screen, the second a login.
        configured,
        authenticated: !requireAuth
          || (configured && verifySessionToken(readCookie(request.headers.cookie, SESSION_COOKIE), record.secret)),
        minPasswordLength: MIN_PASSWORD_LENGTH
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/setup", async (request, response, next) => {
    try {
      const existing = await readAuthImpl();

      if (existing?.hash) {
        // Otherwise anyone reaching the port could replace the password of a
        // controller that already has one.
        throw new KeelarrHttpError("A password is already set. Sign in instead.", 409);
      }

      const password = String(request.body?.password || "");

      if (password.length < MIN_PASSWORD_LENGTH) {
        throw new KeelarrHttpError(`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`, 400);
      }

      const record = await hashPassword(password);
      const secret = randomBytes(32).toString("hex");
      await writeAuthImpl({ ...record, secret, createdAt: new Date().toISOString() });

      response.setHeader("Set-Cookie", buildSessionCookie(createSessionToken(secret)));
      response.json({ ok: true, configured: true, authenticated: true });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/login", async (request, response, next) => {
    try {
      const record = await readAuthImpl();

      if (!record?.hash) {
        throw new KeelarrHttpError("No password has been set yet.", 409);
      }

      if (!(await verifyPassword(String(request.body?.password || ""), record))) {
        // Slow enough to make guessing tedious, short enough not to look broken.
        await new Promise((resolve) => setTimeout(resolve, 750));
        throw new KeelarrHttpError("That password is not correct.", 401);
      }

      response.setHeader("Set-Cookie", buildSessionCookie(createSessionToken(record.secret)));
      response.json({ ok: true, authenticated: true });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/logout", (_request, response) => {
    response.setHeader("Set-Cookie", buildLogoutCookie());
    response.json({ ok: true, authenticated: false });
  });

  /**
   * Everything else under /api is gated.
   *
   * Keelarr drives the Docker socket, so an unauthenticated caller here could
   * start, stop, and delete containers on the host. The static files are left
   * open because the page itself has to load in order to show a login form.
   */
  app.use("/api", async (request, response, next) => {
    if (!requireAuth) {
      request.keelarrAuthenticated = true;
      next();
      return;
    }

    try {
      const record = await readAuthImpl();

      if (!record?.hash) {
        throw new KeelarrHttpError("Keelarr has no password set yet. Open the web interface to choose one.", 401, {
          configured: false
        });
      }

      const token = readCookie(request.headers.cookie, SESSION_COOKIE);

      if (!verifySessionToken(token, record.secret)) {
        throw new KeelarrHttpError("Sign in to continue.", 401, { configured: true });
      }

      request.keelarrAuthenticated = true;
      next();
    } catch (error) {
      next(error);
    }
  });

  app.use(express.static(publicDir));

  app.get("/api/state", async (request, response, next) => {
    try {
      response.json(await keelarrApp.buildState(requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/host/detect", async (request, response, next) => {
    try {
      response.json({
        ok: true,
        ...(await keelarrApp.detectHost(null, requestContext(request)))
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/host/detect", async (request, response, next) => {
    try {
      response.json({
        ok: true,
        ...(await keelarrApp.detectHost(request.body || {}, requestContext(request)))
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/settings", async (request, response, next) => {
    try {
      response.json(await keelarrApp.saveSettings(request.body || {}, requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/setup", async (request, response, next) => {
    try {
      response.json(await keelarrApp.setup(request.body || {}, requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/host/browse", async (request, response, next) => {
    try {
      response.json(await keelarrApp.browseDirectories(request.query.path || "/", requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/import/scan", async (request, response, next) => {
    try {
      response.json(await keelarrApp.scanImportInventory(requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/import/:containerId/preview", async (request, response, next) => {
    try {
      response.json(await keelarrApp.previewImport(request.params.containerId, requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/import/:containerId/adopt-draft", async (request, response, next) => {
    try {
      response.json(await keelarrApp.adoptImportAsDraft(request.params.containerId, requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/import/:containerId/cutover", async (request, response, next) => {
    try {
      // 202: the job is registered, not finished. Poll /api/jobs/:jobId.
      response.status(202).json(
        await keelarrApp.startCutover(request.params.containerId, request.body || {}, requestContext(request))
      );
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/services/:serviceId/revert-cutover", async (request, response, next) => {
    try {
      response.status(202).json(
        await keelarrApp.startCutoverRevert(request.params.serviceId, request.body || {}, requestContext(request))
      );
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/services/:serviceId/rollback", async (request, response, next) => {
    try {
      response.status(202).json(
        await keelarrApp.startRollback(request.params.serviceId, request.body || {}, requestContext(request))
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/wiring/check", async (request, response, next) => {
    try {
      response.json(await keelarrApp.describeWiring(requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/wiring/apply", async (request, response, next) => {
    try {
      response.status(202).json(await keelarrApp.startWiring(request.body || {}, requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/services/:serviceId/removal-preview", async (request, response, next) => {
    try {
      response.json(await keelarrApp.describeRemoval(request.params.serviceId, requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/services/:serviceId/remove", async (request, response, next) => {
    try {
      response.status(202).json(
        await keelarrApp.startRemoval(request.params.serviceId, request.body || {}, requestContext(request))
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/jobs", async (_request, response, next) => {
    try {
      response.json(await keelarrApp.listJobs());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/jobs/:jobId", async (request, response, next) => {
    try {
      response.json(await keelarrApp.getJob(request.params.jobId));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/demo/reset", async (_request, response, next) => {
    try {
      if (typeof keelarrApp.resetDemo !== "function") {
        response.status(404).json({
          ok: false,
          error: "Demo mode is not enabled."
        });
        return;
      }

      response.json(await keelarrApp.resetDemo());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/services/:serviceId/generate", async (request, response, next) => {
    try {
      response.json(await keelarrApp.generateServiceFiles(request.params.serviceId, requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/services/:serviceId/install", async (request, response, next) => {
    try {
      response.json(await keelarrApp.installManagedService(request.params.serviceId, requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/services/:serviceId/restart", async (request, response, next) => {
    try {
      response.json(await keelarrApp.restartManagedService(request.params.serviceId, requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/services/:serviceId/check-update", async (request, response, next) => {
    try {
      response.json(await keelarrApp.checkServiceUpdate(request.params.serviceId, requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/services/:serviceId/upgrade", async (request, response, next) => {
    try {
      response.json(await keelarrApp.upgradeManagedService(request.params.serviceId, requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/self-update", async (request, response, next) => {
    try {
      response.json(await keelarrApp.describeSelfUpdate(requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/self-update/check", async (request, response, next) => {
    try {
      response.json(await keelarrApp.checkSelfUpdate(requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/services/check-all", async (request, response, next) => {
    try {
      response.json(await keelarrApp.checkAllUpdates(requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/services/upgrade-all", async (request, response, next) => {
    try {
      response.status(202).json(await keelarrApp.upgradeAll(request.body || {}, requestContext(request)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/demo/apps/:serviceId", async (request, response, next) => {
    try {
      if (typeof keelarrApp.renderDemoAppPage !== "function") {
        response.status(404).send("Demo mode is not enabled.");
        return;
      }

      const page = await keelarrApp.renderDemoAppPage(request.params.serviceId);
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
