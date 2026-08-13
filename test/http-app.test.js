import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHttpApp } from "../src/create-http-app.js";
import { DemoKeelarrAppService } from "../src/lib/demo-service.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

function stopServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function createTestLogger() {
  const records = [];

  function makeLogger(bindings = {}) {
    return {
      records,
      child(extra = {}) {
        return makeLogger({
          ...bindings,
          ...extra
        });
      },
      debug(event, context = {}) {
        records.push({
          level: "debug",
          event,
          ...bindings,
          ...context
        });
      },
      info(event, context = {}) {
        records.push({
          level: "info",
          event,
          ...bindings,
          ...context
        });
      },
      warn(event, context = {}) {
        records.push({
          level: "warn",
          event,
          ...bindings,
          ...context
        });
      },
      error(event, context = {}) {
        records.push({
          level: "error",
          event,
          ...bindings,
          ...context
        });
      }
    };
  }

  return makeLogger();
}

test("http app serves demo state through the API facade", async () => {
  const logger = createTestLogger();
  const app = createHttpApp({
    publicDir,
    keelarrApp: new DemoKeelarrAppService(),
    logger,
    requireAuth: false
  });
  const server = await startServer(app);

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/state`);
    const data = await response.json();
    const requestLog = logger.records.find((entry) => entry.event === "http.request");

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.meta.mode, "demo");
    assert.equal(Array.isArray(data.services), true);
    assert.equal(typeof response.headers.get("x-request-id"), "string");
    assert.equal(requestLog?.component, "http");
    assert.equal(requestLog?.path, "/api/state");
    assert.equal(requestLog?.statusCode, 200);
  } finally {
    await stopServer(server);
  }
});

test("cutover returns 202 with a pollable job instead of blocking the request", async () => {
  const demo = new DemoKeelarrAppService();
  const app = createHttpApp({ publicDir, keelarrApp: demo, logger: createTestLogger(), requireAuth: false });
  const server = await startServer(app);

  try {
    const base = `http://127.0.0.1:${server.address().port}`;

    // A draft has to exist before the container can be cut over.
    const scan = await (await fetch(`${base}/api/import/scan`)).json();
    const candidate = scan.items.find((item) => item.adoptable && item.serviceId);
    await fetch(`${base}/api/import/${candidate.containerId}/adopt-draft`, { method: "POST" });

    const started = await fetch(`${base}/api/import/${candidate.containerId}/cutover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmContainerName: candidate.containerName })
    });
    const startedBody = await started.json();

    assert.equal(started.status, 202);
    assert.equal(typeof startedBody.job.id, "string");
    // The full step plan is visible immediately, before any step has run.
    assert.ok(startedBody.job.steps.length > 0);

    let job = startedBody.job;
    for (let attempt = 0; attempt < 50 && (job.status === "pending" || job.status === "running"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      job = (await (await fetch(`${base}/api/jobs/${startedBody.job.id}`)).json()).job;
    }

    assert.equal(job.status, "succeeded");
    assert.equal(job.result.outcome, "verified");
    assert.equal(job.steps.find((step) => step.name === "revert").status, "skipped");
  } finally {
    await stopServer(server);
  }
});

test("cutover rejects a request whose confirmation does not match", async () => {
  const demo = new DemoKeelarrAppService();
  const app = createHttpApp({ publicDir, keelarrApp: demo, logger: createTestLogger(), requireAuth: false });
  const server = await startServer(app);

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const scan = await (await fetch(`${base}/api/import/scan`)).json();
    const candidate = scan.items.find((item) => item.adoptable && item.serviceId);
    await fetch(`${base}/api/import/${candidate.containerId}/adopt-draft`, { method: "POST" });

    const response = await fetch(`${base}/api/import/${candidate.containerId}/cutover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmContainerName: "not-the-container" })
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.match(body.error, /confirmation does not match/);
  } finally {
    await stopServer(server);
  }
});

test("an unknown job id is a 404 rather than an empty success", async () => {
  const app = createHttpApp({ publicDir, keelarrApp: new DemoKeelarrAppService(), logger: createTestLogger(), requireAuth: false });
  const server = await startServer(app);

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/jobs/nope`);

    assert.equal(response.status, 404);
  } finally {
    await stopServer(server);
  }
});

test("http app logs request failures with request ids", async () => {
  const logger = createTestLogger();
  const app = createHttpApp({
    publicDir,
    keelarrApp: {
      async buildState() {
        const error = new Error("boom");
        error.statusCode = 503;
        throw error;
      }
    },
    logger,
    requireAuth: false
  });
  const server = await startServer(app);

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/state`);
    const data = await response.json();
    const requestId = response.headers.get("x-request-id");
    const errorLog = logger.records.find((entry) => entry.event === "http.error");
    const requestLog = logger.records.find((entry) => entry.event === "http.request");

    assert.equal(response.status, 503);
    assert.equal(data.ok, false);
    assert.equal(requestId, errorLog?.requestId);
    assert.equal(requestId, requestLog?.requestId);
    assert.equal(errorLog?.message, "boom");
    assert.equal(requestLog?.statusCode, 503);
  } finally {
    await stopServer(server);
  }
});

test("the health endpoint answers before the controller has finished starting", async () => {
  // Initialisation inspects every container and re-attaches the controller to
  // each service network, which took four minutes on a busy NAS. Binding the
  // port after that meant the healthcheck — twenty seconds and three retries —
  // marked a healthy controller unhealthy, and a host that restarts unhealthy
  // containers would have killed it mid-startup, forever.
  let initializeFinished = false;
  const app = createHttpApp({
    publicDir,
    keelarrApp: {
      async initialize() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        initializeFinished = true;
      },
      async buildState() {
        return { ok: true };
      }
    },
    logger: createTestLogger(),
    requireAuth: false
  });
  const server = await startServer(app);

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);

    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    // The point: it answered without waiting for the slow work.
    assert.equal(initializeFinished, false, "health should not depend on initialisation");
  } finally {
    await stopServer(server);
  }
});
