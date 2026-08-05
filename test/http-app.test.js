import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHttpApp } from "../src/create-http-app.js";
import { DemoStackarrAppService } from "../src/lib/demo-service.js";

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
    stackarrApp: new DemoStackarrAppService(),
    logger
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

test("http app logs request failures with request ids", async () => {
  const logger = createTestLogger();
  const app = createHttpApp({
    publicDir,
    stackarrApp: {
      async buildState() {
        const error = new Error("boom");
        error.statusCode = 503;
        throw error;
      }
    },
    logger
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
