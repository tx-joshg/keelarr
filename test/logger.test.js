import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createLogger } from "../src/lib/logger.js";

test("logger writes jsonl records and redacts sensitive fields", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "stackarr-logger-"));
  const filePath = path.join(tempDir, "stackarr.log");
  const logger = createLogger({
    filePath,
    consoleImpl: {
      log() {},
      warn() {},
      error() {},
      debug() {}
    }
  });

  logger.info("service.install", {
    serviceId: "radarr",
    apiKey: "top-secret",
    nested: {
      password: "super-secret"
    },
    stdout: "compose completed"
  });

  await logger.flush();

  const content = await readFile(filePath, "utf8");
  const entry = JSON.parse(content.trim());

  assert.equal(entry.event, "service.install");
  assert.equal(entry.serviceId, "radarr");
  assert.equal(entry.apiKey, "[redacted]");
  assert.equal(entry.nested.password, "[redacted]");
  assert.equal(entry.stdout, "compose completed");
});
