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

test("http app serves demo state through the API facade", async () => {
  const app = createHttpApp({
    publicDir,
    stackarrApp: new DemoStackarrAppService()
  });
  const server = await startServer(app);

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/state`);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.meta.mode, "demo");
    assert.equal(Array.isArray(data.services), true);
  } finally {
    await stopServer(server);
  }
});
