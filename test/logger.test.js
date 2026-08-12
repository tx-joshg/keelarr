import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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

function silentLogger(filePath, options = {}) {
  return createLogger({
    filePath,
    consoleImpl: { log() {}, warn() {}, error() {}, debug() {} },
    ...options
  });
}

test("the log rolls over instead of growing without limit", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "stackarr-logrotate-"));
  const filePath = path.join(tempDir, "stackarr.log");
  const logger = silentLogger(filePath, { maxBytes: 2_000, keep: 2 });

  for (let index = 0; index < 200; index += 1) {
    logger.info("command.finish", { index, stdout: "x".repeat(100) });
  }

  await logger.flush();

  const live = await stat(filePath);
  const first = await stat(`${filePath}.1`);
  const second = await stat(`${filePath}.2`);

  assert.ok(live.size <= 2_000, `live log is ${live.size} bytes`);
  assert.ok(first.size > 0);
  assert.ok(second.size > 0);

  // Only `keep` old files, so the total is bounded no matter how long it runs.
  assert.equal(await stat(`${filePath}.3`).then(() => true).catch(() => false), false);

  // The newest entry is in the live file, not stranded in a rotated one.
  const content = await readFile(filePath, "utf8");
  assert.match(content, /"index":199/);
});

test("rotation counts a log that was already there before this process started", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "stackarr-logresume-"));
  const filePath = path.join(tempDir, "stackarr.log");

  // Stands in for a restart onto a log that is already at the cap. Counting
  // only this process's own writes would let it grow to twice the limit.
  await writeFile(filePath, "x".repeat(3_000), "utf8");

  const logger = silentLogger(filePath, { maxBytes: 2_000, keep: 1 });
  logger.info("server.listen", { port: 4687 });
  await logger.flush();

  const rotated = await readFile(`${filePath}.1`, "utf8");
  const live = await readFile(filePath, "utf8");

  assert.equal(rotated.length, 3_000);
  assert.match(live, /server\.listen/);
});

test("a cap of zero keeps the old unbounded behaviour", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "stackarr-lognorotate-"));
  const filePath = path.join(tempDir, "stackarr.log");
  const logger = silentLogger(filePath, { maxBytes: 0 });

  for (let index = 0; index < 50; index += 1) {
    logger.info("http.request", { index, path: "/api/state" });
  }

  await logger.flush();

  assert.equal(await stat(`${filePath}.1`).then(() => true).catch(() => false), false);
  assert.equal((await readFile(filePath, "utf8")).trim().split("\n").length, 50);
});
