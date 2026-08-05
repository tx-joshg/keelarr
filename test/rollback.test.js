import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { ManagedStackService } from "../src/lib/app-services/managed-stack-service.js";
import { JOB_STATUS, JobRegistry, STEP_STATUS } from "../src/lib/jobs.js";
import { HEALTH_OUTCOME } from "../src/lib/health.js";
import { findRollbackPoint } from "../src/lib/runtime.js";
import { readComposeImage, setComposeImage } from "../src/lib/generator.js";
import { createLogger } from "../src/lib/logger.js";
import { normalizeSettings } from "../src/lib/store.js";

const noop = () => {};
const silentLogger = createLogger({
  level: "error",
  filePath: path.join(tmpdir(), "stackarr-test.log"),
  consoleImpl: { debug: noop, info: noop, warn: noop, error: noop, log: noop }
});

const COMPOSE = `name: radarr
services:
  radarr:
    container_name: radarr
    image: linuxserver/radarr:latest
    restart: unless-stopped
`;

async function createStack(t) {
  const root = await mkdtemp(path.join(tmpdir(), "stackarr-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const stackDir = path.join(root, "radarr");
  await mkdir(stackDir, { recursive: true });
  await writeFile(path.join(stackDir, "compose.yml"), COMPOSE, "utf8");
  await writeFile(path.join(stackDir, ".env"), "PUID=0\n", "utf8");

  const settings = normalizeSettings({
    initialized: true,
    stackRoot: root,
    selectedServiceIds: ["radarr"],
    serviceOverrides: { radarr: { mode: "imported", image: "linuxserver/radarr:latest", containerName: "radarr" } }
  });
  settings.services.radarr.stackDir = stackDir;
  settings.services.radarr.composePath = path.join(stackDir, "compose.yml");
  settings.services.radarr.envPath = path.join(stackDir, ".env");

  return { root, stackDir, settings };
}

async function writeBackup(root, stamp, record) {
  const dir = path.join(root, ".stackarr-backups", "radarr", stamp);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "rollback.json"), JSON.stringify(record), "utf8");
  return dir;
}

async function settle(job) {
  while (job.status === JOB_STATUS.PENDING || job.status === JOB_STATUS.RUNNING) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return job;
}

test("setComposeImage pins the image and readComposeImage reads it back", async (t) => {
  const { settings } = await createStack(t);
  const service = settings.services.radarr;

  const result = await setComposeImage(service, "linuxserver/radarr@sha256:old");

  assert.equal(result.previousImage, "linuxserver/radarr:latest");
  assert.equal(await readComposeImage(service), "linuxserver/radarr@sha256:old");
  // The rest of the file must survive the rewrite.
  const text = await readFile(service.composePath, "utf8");
  assert.match(text, /container_name: radarr/);
  assert.match(text, /restart: unless-stopped/);
});

test("findRollbackPoint picks the newest backup that differs from the running image", async (t) => {
  const { root, settings } = await createStack(t);
  await writeBackup(root, "2026-08-01T00-00-00-000Z", { imageId: "sha256:oldest", imageRepoDigest: "repo@sha256:oldest" });
  await writeBackup(root, "2026-08-03T00-00-00-000Z", { imageId: "sha256:previous", imageRepoDigest: "repo@sha256:previous" });
  // Newest records the image that is running now, so it is not a rollback target.
  await writeBackup(root, "2026-08-05T00-00-00-000Z", { imageId: "sha256:current", imageRepoDigest: "repo@sha256:current" });

  const point = await findRollbackPoint(settings, settings.services.radarr, { runningImageId: "sha256:current" });

  assert.equal(point.imageId, "sha256:previous");
  assert.equal(point.imageRef, "repo@sha256:previous");
});

test("findRollbackPoint returns null when no backup records a usable image", async (t) => {
  const { root, settings } = await createStack(t);
  await writeBackup(root, "2026-08-01T00-00-00-000Z", { imageId: null, imageRepoDigest: null });

  assert.equal(await findRollbackPoint(settings, settings.services.radarr, { runningImageId: "sha256:current" }), null);
});

function createService(t, stack, overrides = {}) {
  const calls = [];
  const ok = { ok: true, stdout: "", stderr: "", code: 0 };

  return {
    calls,
    service: new ManagedStackService({
      logger: silentLogger,
      jobs: new JobRegistry({ logger: silentLogger }),
      loadSettingsImpl: async () => stack.settings,
      backupServiceImpl: async () => {
        calls.push("backup");
        return { backupDir: "/backups/radarr/x", rollback: {} };
      },
      imageExistsLocallyImpl: async () => overrides.imageMissing !== true,
      generateAndDeployImpl: async () => {
        calls.push("compose-up");
        return overrides.deployResult || ok;
      },
      verifyServiceHealthImpl: async () => {
        calls.push("verify");
        return overrides.health || { outcome: HEALTH_OUTCOME.VERIFIED, reason: "healthy" };
      },
      readUpdateStateImpl: async () => ({}),
      writeUpdateStateImpl: async () => ({}),
      appendActivityImpl: async () => {},
      ...overrides.impls
    })
  };
}

test("rollback pins the previous image, recreates, and records the result", async (t) => {
  const stack = await createStack(t);
  await writeBackup(stack.root, "2026-08-03T00-00-00-000Z", {
    imageId: "sha256:previous",
    imageRepoDigest: "linuxserver/radarr@sha256:previous",
    image: "linuxserver/radarr:latest"
  });

  const { service, calls } = createService(t, stack);
  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr" }));

  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);
  assert.equal(job.result.rolledBackTo, "linuxserver/radarr@sha256:previous");
  assert.deepEqual(calls, ["backup", "compose-up", "verify"]);
  // The pin must actually be written to the compose file.
  assert.equal(await readComposeImage(stack.settings.services.radarr), "linuxserver/radarr@sha256:previous");
  assert.equal(job.steps.find((s) => s.name === "restore").status, STEP_STATUS.SKIPPED);
});

test("a rollback that fails to come up restores the newer image", async (t) => {
  const stack = await createStack(t);
  await writeBackup(stack.root, "2026-08-03T00-00-00-000Z", {
    imageId: "sha256:previous",
    imageRepoDigest: "linuxserver/radarr@sha256:previous"
  });

  const { service } = createService(t, stack, {
    health: { outcome: HEALTH_OUTCOME.FAILED, reason: "Container is exited." }
  });
  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr" }));

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.equal(job.error.details.restored, true);
  // Back on the image it started from, not stuck on the bad pin.
  assert.equal(await readComposeImage(stack.settings.services.radarr), "linuxserver/radarr:latest");
});

test("rollback refuses when the previous image is gone from the host", async (t) => {
  const stack = await createStack(t);
  await writeBackup(stack.root, "2026-08-03T00-00-00-000Z", {
    imageId: "sha256:previous",
    imageRepoDigest: "linuxserver/radarr@sha256:previous"
  });

  const { service, calls } = createService(t, stack, { imageMissing: true });
  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr" }));

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.match(job.error.message, /no longer present on this host/);
  assert.deepEqual(calls, []);
});

test("rollback refuses when nothing was ever backed up", async (t) => {
  const stack = await createStack(t);
  const { service } = createService(t, stack);
  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr" }));

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.match(job.error.message, /No previous image is recorded/);
});

test("a mismatched confirmation blocks rollback before anything is touched", async (t) => {
  const stack = await createStack(t);
  await writeBackup(stack.root, "2026-08-03T00-00-00-000Z", { imageId: "sha256:previous", imageRepoDigest: "r@sha256:previous" });

  const { service, calls } = createService(t, stack);
  const job = await settle(service.startRollback("radarr", { confirmContainerName: "wrong" }));

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.match(job.error.message, /confirmation does not match/);
  assert.deepEqual(calls, []);
});

test("upgrading clears a rollback pin so the service can move forward again", async (t) => {
  const stack = await createStack(t);
  const svc = stack.settings.services.radarr;
  await setComposeImage(svc, "linuxserver/radarr@sha256:previous");

  const upgraded = [];
  const service = new ManagedStackService({
    logger: silentLogger,
    loadSettingsImpl: async () => stack.settings,
    upgradeServiceImpl: async () => {
      upgraded.push(await readComposeImage(svc));
      return { ok: true, stdout: "", stderr: "" };
    },
    readUpdateStateImpl: async () => ({}),
    writeUpdateStateImpl: async () => ({}),
    appendActivityImpl: async () => {}
  });

  await service.upgradeManagedService("radarr");

  // The pin has to be gone *before* the pull, or it would re-resolve the
  // pinned digest and never move forward.
  assert.deepEqual(upgraded, ["linuxserver/radarr:latest"]);
});
