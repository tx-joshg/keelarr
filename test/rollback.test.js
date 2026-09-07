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
  filePath: path.join(tmpdir(), "keelarr-test.log"),
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
  const root = await mkdtemp(path.join(tmpdir(), "keelarr-rollback-"));
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
  const dir = path.join(root, ".keelarr-backups", "radarr", stamp);
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
      readContainerImageIdImpl: async () => "sha256:previous",
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
    readContainerImageIdImpl: async () => "sha256:previous",
    upgradeServiceImpl: async () => {
      upgraded.push(await readComposeImage(svc));
      return { ok: true, stdout: "", stderr: "" };
    },
    verifyServiceHealthImpl: async () => ({ outcome: HEALTH_OUTCOME.VERIFIED, reason: "healthy" }),
    readUpdateStateImpl: async () => ({}),
    writeUpdateStateImpl: async () => ({}),
    appendActivityImpl: async () => {}
  });

  await service.upgradeManagedService("radarr");

  // The pin has to be gone *before* the pull, or it would re-resolve the
  // pinned digest and never move forward.
  assert.deepEqual(upgraded, ["linuxserver/radarr:latest"]);
});

test("a successful upgrade clears a stale update status", async (t) => {
  const stack = await createStack(t);
  const stored = { radarr: { status: "rolled-back", checkedAt: "2026-08-05T00:00:00.000Z" } };

  const service = new ManagedStackService({
    logger: silentLogger,
    loadSettingsImpl: async () => stack.settings,
    readContainerImageIdImpl: async () => "sha256:previous",
    upgradeServiceImpl: async () => ({ ok: true, stdout: "", stderr: "" }),
    verifyServiceHealthImpl: async () => ({ outcome: HEALTH_OUTCOME.VERIFIED, reason: "healthy" }),
    readUpdateStateImpl: async () => stored,
    writeUpdateStateImpl: async (next) => Object.assign(stored, next),
    appendActivityImpl: async () => {}
  });

  await service.upgradeManagedService("radarr");

  // Reporting "rolled-back" after moving forward would be plainly wrong.
  assert.equal(stored.radarr.status, "current");
});

test("rollback restores the config snapshot only when asked and one exists", async (t) => {
  const stack = await createStack(t);
  await writeBackup(stack.root, "2026-08-03T00-00-00-000Z", {
    imageId: "sha256:previous",
    imageRepoDigest: "linuxserver/radarr@sha256:previous",
    configSnapshot: { file: "config-snapshot.tar.gz", mountType: "volume", mountSource: "radarr_config" }
  });

  const restored = [];
  const { service } = createService(t, stack, {
    impls: {
      readConfigMountSourceImpl: async () => ({ type: "volume", source: "radarr_config" }),
      composeDownImpl: async () => ({ ok: true, stdout: "", stderr: "" }),
      restoreConfigSnapshotImpl: async (_s, _svc, dir) => {
        restored.push(dir);
        return { ok: true };
      }
    }
  });

  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr", restoreConfig: true }));

  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);
  assert.equal(job.result.configRestored, true);
  assert.equal(restored.length, 1);
  assert.equal(job.steps.find((s) => s.name === "restore-config").status, STEP_STATUS.SUCCEEDED);
});

test("rollback leaves configuration alone by default", async (t) => {
  const stack = await createStack(t);
  await writeBackup(stack.root, "2026-08-03T00-00-00-000Z", {
    imageId: "sha256:previous",
    imageRepoDigest: "linuxserver/radarr@sha256:previous",
    configSnapshot: { file: "config-snapshot.tar.gz" }
  });

  const restored = [];
  const { service } = createService(t, stack, {
    impls: {
      restoreConfigSnapshotImpl: async () => {
        restored.push(1);
        return { ok: true };
      }
    }
  });

  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr" }));

  assert.equal(job.status, JOB_STATUS.SUCCEEDED);
  assert.equal(job.result.configRestored, false);
  assert.deepEqual(restored, []);
  assert.equal(job.steps.find((s) => s.name === "restore-config").status, STEP_STATUS.SKIPPED);
});

test("asking to restore config when none was captured is reported, not silently ignored", async (t) => {
  const stack = await createStack(t);
  await writeBackup(stack.root, "2026-08-03T00-00-00-000Z", {
    imageId: "sha256:previous",
    imageRepoDigest: "linuxserver/radarr@sha256:previous"
  });

  const { service } = createService(t, stack);
  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr", restoreConfig: true }));

  assert.equal(job.status, JOB_STATUS.SUCCEEDED);
  assert.equal(job.result.configRestored, false);
  const step = job.steps.find((s) => s.name === "restore-config");
  assert.equal(step.status, STEP_STATUS.SKIPPED);
  assert.match(step.detail, /No configuration snapshot/);
});

test("the config mount is read before the container is removed", async (t) => {
  const stack = await createStack(t);
  await writeBackup(stack.root, "2026-08-03T00-00-00-000Z", {
    imageId: "sha256:previous",
    imageRepoDigest: "linuxserver/radarr@sha256:previous",
    configSnapshot: { file: "config-snapshot.tar.gz" }
  });

  const order = [];
  const { service } = createService(t, stack, {
    impls: {
      readConfigMountSourceImpl: async () => {
        order.push("read-mount");
        return { type: "volume", source: "radarr_config" };
      },
      composeDownImpl: async () => {
        order.push("compose-down");
        return { ok: true };
      },
      restoreConfigSnapshotImpl: async (_s, _svc, _dir, opts) => {
        order.push(`restore(mount=${opts?.mount?.source})`);
        return { ok: true };
      }
    }
  });

  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr", restoreConfig: true }));

  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);
  // Reading the mount after compose-down would inspect a container that no
  // longer exists, which is exactly how this failed on the live NAS.
  assert.deepEqual(order, ["read-mount", "compose-down", "restore(mount=radarr_config)"]);
});

test("a failed config restore brings the service back up instead of leaving it stopped", async (t) => {
  const stack = await createStack(t);
  await writeBackup(stack.root, "2026-08-03T00-00-00-000Z", {
    imageId: "sha256:previous",
    imageRepoDigest: "linuxserver/radarr@sha256:previous",
    configSnapshot: { file: "config-snapshot.tar.gz" }
  });

  const deploys = [];
  const { service } = createService(t, stack, {
    impls: {
      readConfigMountSourceImpl: async () => ({ type: "bind", source: "/config" }),
      composeDownImpl: async () => ({ ok: true }),
      restoreConfigSnapshotImpl: async () => ({ ok: false, reason: "tar failed" }),
      generateAndDeployImpl: async () => {
        deploys.push("redeploy");
        return { ok: true, stdout: "", stderr: "" };
      }
    }
  });

  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr", restoreConfig: true }));

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.match(job.error.message, /Unable to restore the saved configuration/);
  assert.equal(job.error.details.serviceRestarted, true);
  assert.deepEqual(deploys, ["redeploy"]);
});

test("rollback refuses up front when the config mount cannot be found", async (t) => {
  const stack = await createStack(t);
  await writeBackup(stack.root, "2026-08-03T00-00-00-000Z", {
    imageId: "sha256:previous",
    imageRepoDigest: "linuxserver/radarr@sha256:previous",
    configSnapshot: { file: "config-snapshot.tar.gz" }
  });

  const { service, calls } = createService(t, stack, {
    impls: { readConfigMountSourceImpl: async () => null }
  });

  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr", restoreConfig: true }));

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.match(job.error.message, /no \/config mount was found/);
  // Nothing touched: it failed in preflight.
  assert.deepEqual(calls, []);
});

/* --- Upgrade All must behave exactly like the per-service upgrade --- */

// Waits on the job itself rather than a tick budget. The previous version gave
// up after 500 event-loop ticks, which on a loaded CI runner elapsed in 19ms
// while the job was still doing real I/O — reporting "job never settled" for a
// job that was fine.
async function settleJobById(service, jobId) {
  return service.jobs.settled(jobId);
}

function createStackWith(t, ids) {
  return createStack(t).then(async (stack) => {
    const { mkdir: md, writeFile: wf } = await import("node:fs/promises");
    const settings = normalizeSettings({
      initialized: true,
      stackRoot: stack.root,
      selectedServiceIds: ids,
      serviceOverrides: Object.fromEntries(ids.map((id) => [id, { mode: "imported", containerName: id }]))
    });
    for (const id of ids) {
      const dir = path.join(stack.root, id);
      await md(dir, { recursive: true });
      await wf(path.join(dir, "compose.yml"), `name: ${id}\nservices:\n  ${id}:\n    image: img/${id}:latest\n`, "utf8");
      await wf(path.join(dir, ".env"), "PUID=0\n", "utf8");
      settings.services[id].stackDir = dir;
      settings.services[id].composePath = path.join(dir, "compose.yml");
      settings.services[id].envPath = path.join(dir, ".env");
    }
    return { ...stack, settings };
  });
}

test("Upgrade All clears pins and refreshes status for every service, like the single upgrade", async (t) => {
  const stack = await createStackWith(t, ["radarr", "sonarr"]);
  // Both start pinned, the state a rollback leaves behind.
  for (const id of ["radarr", "sonarr"]) {
    await setComposeImage(stack.settings.services[id], `img/${id}@sha256:pinned`);
  }

  // Known to need an update: since checking became a deliberate act, that is
  // the precondition for Upgrade All touching anything.
  const updateState = { radarr: { status: "ready" }, sonarr: { status: "ready" } };
  const pulled = [];
  const service = new ManagedStackService({
    logger: silentLogger,
    jobs: new JobRegistry({ logger: silentLogger }),
    loadSettingsImpl: async () => stack.settings,
    readContainerImageIdImpl: async () => "sha256:previous",
    upgradeServiceImpl: async (_s, svc) => {
      pulled.push(await readComposeImage(svc));
      return { ok: true, stdout: "", stderr: "" };
    },
    verifyServiceHealthImpl: async () => ({ outcome: HEALTH_OUTCOME.VERIFIED, reason: "healthy" }),
    readUpdateStateImpl: async () => updateState,
    writeUpdateStateImpl: async (next) => Object.assign(updateState, next),
    appendActivityImpl: async () => {}
  });

  const job = await settleJobById(service, (await service.startUpgradeAll().create()).id);

  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);
  assert.equal(job.result.upgraded, 2);
  // The old Upgrade All never cleared pins, so it would have re-pulled the
  // digest and the service could never move forward. Each pull must see the
  // configured tag instead.
  assert.deepEqual(pulled, [
    stack.settings.services.radarr.image,
    stack.settings.services.sonarr.image
  ]);
  assert.ok(pulled.every((ref) => !ref.includes("@sha256:")));
  assert.equal(updateState.radarr.status, "current");
  assert.equal(updateState.sonarr.status, "current");
});

test("Upgrade All keeps going when one service fails and reports the split", async (t) => {
  const stack = await createStackWith(t, ["radarr", "sonarr", "ombi"]);
  const attempted = [];
  const service = new ManagedStackService({
    logger: silentLogger,
    jobs: new JobRegistry({ logger: silentLogger }),
    loadSettingsImpl: async () => stack.settings,
    readContainerImageIdImpl: async () => "sha256:previous",
    upgradeServiceImpl: async (_s, svc) => {
      attempted.push(svc.id);
      return svc.id === "sonarr"
        ? { ok: false, stdout: "", stderr: "manifest unknown" }
        : { ok: true, stdout: "", stderr: "" };
    },
    verifyServiceHealthImpl: async () => ({ outcome: HEALTH_OUTCOME.VERIFIED, reason: "healthy" }),
    readUpdateStateImpl: async () => ({
      radarr: { status: "ready" },
      sonarr: { status: "ready" },
      ombi: { status: "ready" }
    }),
    writeUpdateStateImpl: async () => ({}),
    appendActivityImpl: async () => {}
  });

  const job = await settleJobById(service, (await service.startUpgradeAll().create()).id);

  // A mid-stack failure must not strand the remaining services.
  assert.deepEqual(attempted, ["radarr", "sonarr", "ombi"]);
  assert.equal(job.result.upgraded, 2);
  assert.equal(job.result.failed, 1);
  assert.equal(job.steps.find((s) => s.name === "sonarr").status, STEP_STATUS.FAILED);
  assert.equal(job.steps.find((s) => s.name === "ombi").status, STEP_STATUS.SUCCEEDED);
});

test("Upgrade All reports a service that upgrades but does not come back healthy", async (t) => {
  const stack = await createStackWith(t, ["radarr"]);
  const service = new ManagedStackService({
    logger: silentLogger,
    jobs: new JobRegistry({ logger: silentLogger }),
    loadSettingsImpl: async () => stack.settings,
    readContainerImageIdImpl: async () => "sha256:previous",
    upgradeServiceImpl: async () => ({ ok: true, stdout: "", stderr: "" }),
    verifyServiceHealthImpl: async () => ({ outcome: HEALTH_OUTCOME.FAILED, reason: "Container is exited." }),
    readUpdateStateImpl: async () => ({ radarr: { status: "ready" } }),
    writeUpdateStateImpl: async () => ({}),
    appendActivityImpl: async () => {}
  });

  const job = await settleJobById(service, (await service.startUpgradeAll().create()).id);

  // Pulling successfully is not the same as the app working.
  assert.equal(job.result.failed, 1);
  assert.match(job.steps[0].error, /Container is exited/);
});

test("Upgrade All skips services that were never installed", async (t) => {
  const stack = await createStackWith(t, ["radarr"]);
  stack.settings.selectedServiceIds = ["radarr", "bazarr"];
  stack.settings.services.bazarr = {
    ...stack.settings.services.radarr,
    id: "bazarr",
    name: "Bazarr",
    containerName: "bazarr",
    composePath: path.join(stack.root, "bazarr", "compose.yml")
  };

  const attempted = [];
  const service = new ManagedStackService({
    logger: silentLogger,
    jobs: new JobRegistry({ logger: silentLogger }),
    loadSettingsImpl: async () => stack.settings,
    readContainerImageIdImpl: async () => "sha256:previous",
    upgradeServiceImpl: async (_s, svc) => {
      attempted.push(svc.id);
      return { ok: true, stdout: "", stderr: "" };
    },
    verifyServiceHealthImpl: async () => ({ outcome: HEALTH_OUTCOME.VERIFIED, reason: "healthy" }),
    readUpdateStateImpl: async () => ({ radarr: { status: "ready" }, bazarr: { status: "ready" } }),
    writeUpdateStateImpl: async () => ({}),
    appendActivityImpl: async () => {}
  });

  const job = await settleJobById(service, (await service.startUpgradeAll().create()).id);

  assert.deepEqual(attempted, ["radarr"]);
  assert.equal(job.result.skipped, 1);
  assert.equal(job.result.failed, 0);
});

test("Upgrade All only touches services that actually have an update", async (t) => {
  const stack = await createStackWith(t, ["radarr", "sonarr", "ombi"]);
  const attempted = [];
  const service = new ManagedStackService({
    logger: silentLogger,
    jobs: new JobRegistry({ logger: silentLogger }),
    loadSettingsImpl: async () => stack.settings,
    readContainerImageIdImpl: async () => "sha256:previous",
    upgradeServiceImpl: async (_s, svc) => {
      attempted.push(svc.id);
      return { ok: true, stdout: "", stderr: "" };
    },
    verifyServiceHealthImpl: async () => ({ outcome: HEALTH_OUTCOME.VERIFIED, reason: "healthy" }),
    readUpdateStateImpl: async () => ({
      radarr: { status: "ready" },
      sonarr: { status: "current" },
      ombi: { status: "current" }
    }),
    writeUpdateStateImpl: async () => ({}),
    appendActivityImpl: async () => {}
  });

  const job = await settleJobById(service, (await service.startUpgradeAll().create()).id);

  // Recreating an already-current live service is pointless churn and a
  // needless chance for it not to come back.
  assert.deepEqual(attempted, ["radarr"]);
  assert.equal(job.result.upgraded, 1);
  assert.equal(job.result.skipped, 2);
  // Not a step reporting "succeeded" — not a step at all. Five services
  // silently reporting success is what made a three-service upgrade look like
  // a whole-stack one.
  assert.deepEqual(job.steps.map((step) => step.name), ["radarr"]);
});

test("Upgrade All with force re-pulls everything regardless of status", async (t) => {
  const stack = await createStackWith(t, ["radarr", "sonarr"]);
  const attempted = [];
  const service = new ManagedStackService({
    logger: silentLogger,
    jobs: new JobRegistry({ logger: silentLogger }),
    loadSettingsImpl: async () => stack.settings,
    readContainerImageIdImpl: async () => "sha256:previous",
    upgradeServiceImpl: async (_s, svc) => {
      attempted.push(svc.id);
      return { ok: true, stdout: "", stderr: "" };
    },
    verifyServiceHealthImpl: async () => ({ outcome: HEALTH_OUTCOME.VERIFIED, reason: "healthy" }),
    readUpdateStateImpl: async () => ({ radarr: { status: "current" }, sonarr: { status: "current" } }),
    writeUpdateStateImpl: async () => ({}),
    appendActivityImpl: async () => {}
  });

  const job = await settleJobById(service, (await service.startUpgradeAll({ force: true }).create()).id);

  assert.deepEqual(attempted, ["radarr", "sonarr"]);
  assert.equal(job.result.upgraded, 2);
});

test("Upgrade All says so plainly when there is nothing to do", async (t) => {
  const stack = await createStackWith(t, ["radarr"]);
  const service = new ManagedStackService({
    logger: silentLogger,
    jobs: new JobRegistry({ logger: silentLogger }),
    loadSettingsImpl: async () => stack.settings,
    readContainerImageIdImpl: async () => "sha256:previous",
    upgradeServiceImpl: async () => ({ ok: true, stdout: "", stderr: "" }),
    readUpdateStateImpl: async () => ({ radarr: { status: "current" } }),
    writeUpdateStateImpl: async () => ({}),
    appendActivityImpl: async () => {}
  });

  const outcome = await service.startUpgradeAll().create();

  // A progress panel that exists only to say nothing happened is noise, so
  // there is no job — just the answer.
  assert.equal(outcome.job, null);
  assert.equal(outcome.upgraded, 0);
  assert.match(outcome.message, /already up to date/i);
});

/* --- a freshly deployed service must not report "Unknown" --- */

function createDeployService(t, stack, updateState, deployed) {
  return new ManagedStackService({
    logger: silentLogger,
    loadSettingsImpl: async () => stack.settings,
    readContainerImageIdImpl: async () => "sha256:previous",
    ensureSharedNetworkImpl: async () => ({ ok: true, created: false }),
    generateAndDeployImpl: async (_s, svc) => {
      deployed.push(svc.id);
      return { ok: true, stdout: "", stderr: "" };
    },
    installServiceImpl: async (_s, svc) => {
      deployed.push(`install:${svc.id}`);
      return { ok: true, stdout: "", stderr: "" };
    },
    writeStacksImpl: async () => [],
    readUpdateStateImpl: async () => updateState,
    writeUpdateStateImpl: async (next) => Object.assign(updateState, next),
    appendActivityImpl: async () => {}
  });
}

test("Save And Deploy records the freshly pulled state, not Unknown", async (t) => {
  const stack = await createStackWith(t, ["lidarr"]);
  const updateState = {};
  const deployed = [];
  const service = createDeployService(t, stack, updateState, deployed);

  await service.deploySelected(stack.settings, ["lidarr"]);

  assert.deepEqual(deployed, ["lidarr"]);
  // A deploy just resolved and pulled the tag; reporting "Unknown" until a
  // manual update check is plainly wrong.
  assert.equal(updateState.lidarr.status, "current");
  assert.ok(updateState.lidarr.checkedAt);
});

test("per-service install records the same state as Save And Deploy", async (t) => {
  const stack = await createStackWith(t, ["lidarr"]);
  const updateState = {};
  const deployed = [];
  const service = createDeployService(t, stack, updateState, deployed);

  await service.installManagedService("lidarr");

  assert.deepEqual(deployed, ["install:lidarr"]);
  assert.equal(updateState.lidarr.status, "current");
});

test("a failed deploy does not claim the service is current", async (t) => {
  const stack = await createStackWith(t, ["lidarr"]);
  const updateState = {};
  const service = new ManagedStackService({
    logger: silentLogger,
    loadSettingsImpl: async () => stack.settings,
    readContainerImageIdImpl: async () => "sha256:previous",
    ensureSharedNetworkImpl: async () => ({ ok: true, created: false }),
    generateAndDeployImpl: async () => ({ ok: false, stdout: "", stderr: "port in use" }),
    readUpdateStateImpl: async () => updateState,
    writeUpdateStateImpl: async (next) => Object.assign(updateState, next),
    appendActivityImpl: async () => {}
  });

  const [result] = await service.deploySelected(stack.settings, ["lidarr"]);

  assert.equal(result.ok, false);
  assert.equal(updateState.lidarr, undefined);
});

/* --- backup retention --- */

async function seedBackups(root, serviceId, stamps) {
  const { mkdir: md, writeFile: wf } = await import("node:fs/promises");
  for (const stamp of stamps) {
    const dir = path.join(root, ".keelarr-backups", serviceId, stamp);
    await md(dir, { recursive: true });
    await wf(path.join(dir, "rollback.json"), JSON.stringify({ imageId: `sha256:${stamp}` }), "utf8");
  }
}

test("pruning keeps only the newest backups the retention setting allows", async (t) => {
  const { pruneServiceBackups } = await import("../src/lib/runtime.js");
  const { readdir } = await import("node:fs/promises");
  const stack = await createStack(t);

  await seedBackups(stack.root, "radarr", [
    "2026-08-01T00-00-00-000Z",
    "2026-08-02T00-00-00-000Z",
    "2026-08-03T00-00-00-000Z",
    "2026-08-04T00-00-00-000Z"
  ]);

  const result = await pruneServiceBackups({ ...stack.settings, backupRetention: 2 }, "radarr");

  assert.equal(result.pruned, 2);
  const left = (await readdir(path.join(stack.root, ".keelarr-backups", "radarr"))).sort();
  // Timestamped dirs sort chronologically, so the newest are the tail.
  assert.deepEqual(left, ["2026-08-03T00-00-00-000Z", "2026-08-04T00-00-00-000Z"]);
});

test("retention of 1 leaves exactly the latest backup", async (t) => {
  const { pruneServiceBackups } = await import("../src/lib/runtime.js");
  const { readdir } = await import("node:fs/promises");
  const stack = await createStack(t);

  await seedBackups(stack.root, "radarr", ["2026-08-01T00-00-00-000Z", "2026-08-05T00-00-00-000Z"]);
  await pruneServiceBackups({ ...stack.settings, backupRetention: 1 }, "radarr");

  assert.deepEqual(await readdir(path.join(stack.root, ".keelarr-backups", "radarr")), ["2026-08-05T00-00-00-000Z"]);
});

test("a retention of 0 keeps everything", async (t) => {
  const { pruneServiceBackups } = await import("../src/lib/runtime.js");
  const { readdir } = await import("node:fs/promises");
  const stack = await createStack(t);

  await seedBackups(stack.root, "radarr", ["2026-08-01T00-00-00-000Z", "2026-08-02T00-00-00-000Z", "2026-08-03T00-00-00-000Z"]);
  const result = await pruneServiceBackups({ ...stack.settings, backupRetention: 0 }, "radarr");

  assert.equal(result.pruned, 0);
  assert.equal((await readdir(path.join(stack.root, ".keelarr-backups", "radarr"))).length, 3);
});

test("pruning a service that has no backups yet is not an error", async (t) => {
  const { pruneServiceBackups } = await import("../src/lib/runtime.js");
  const stack = await createStack(t);

  const result = await pruneServiceBackups({ ...stack.settings, backupRetention: 1 }, "neverbackedup");
  assert.equal(result.pruned, 0);
});

test("a deploy that changed nothing says so instead of claiming a deployment", async (t) => {
  // Compose is idempotent: an unchanged service is checked and left alone, and
  // reports "Running" rather than "Recreated". Save And Deploy visits every
  // selected service, so calling each visit a deployment made one real change
  // read as nine.
  const stack = await createStack(t);
  const entries = [];
  const service = new ManagedStackService({
    logger: silentLogger,
    loadSettingsImpl: async () => stack.settings,
    readContainerImageIdImpl: async () => "sha256:previous",
    ensureSharedNetworkImpl: async () => ({ ok: true, created: false }),
    generateAndDeployImpl: async () => ({ ok: true, stdout: "", stderr: " Container radarr Running \n" }),
    readUpdateStateImpl: async () => ({}),
    writeUpdateStateImpl: async () => ({}),
    appendActivityImpl: async (entry) => entries.push(entry)
  });

  await service.deployOne(stack.settings, stack.settings.services.radarr, silentLogger);

  const deploy = entries.find((entry) => entry.kind === "deploy");
  assert.match(deploy.message, /already up to date/);
  assert.equal(deploy.details.unchanged, true);
});

test("a deploy that recreated the container still reports a deployment", async (t) => {
  const stack = await createStack(t);
  const entries = [];
  const service = new ManagedStackService({
    logger: silentLogger,
    loadSettingsImpl: async () => stack.settings,
    readContainerImageIdImpl: async () => "sha256:previous",
    ensureSharedNetworkImpl: async () => ({ ok: true, created: false }),
    generateAndDeployImpl: async () => ({
      ok: true,
      stdout: "",
      stderr: " Container radarr Recreated \n Container radarr Started \n"
    }),
    readUpdateStateImpl: async () => ({}),
    writeUpdateStateImpl: async () => ({}),
    appendActivityImpl: async (entry) => entries.push(entry)
  });

  await service.deployOne(stack.settings, stack.settings.services.radarr, silentLogger);

  const deploy = entries.find((entry) => entry.kind === "deploy");
  assert.match(deploy.message, /^Deployed/);
  assert.equal(deploy.details.unchanged, false);
});

// --- revert on unhealthy -------------------------------------------------------

/**
 * The upgrade path with every collaborator stubbed and its calls recorded, so a
 * test can assert not just the outcome but the order things happened in —
 * which is the whole question for a revert.
 */
function createUpgradeService(t, stack, overrides = {}) {
  const calls = [];
  const writes = [];
  const activity = [];
  const stored = overrides.stored || {};
  const ok = { ok: true, stdout: "", stderr: "", code: 0 };
  const point = overrides.point === undefined
    ? { imageId: "sha256:previous", imageRef: "linuxserver/radarr@sha256:previous", taggedImage: "linuxserver/radarr:latest" }
    : overrides.point;

  const service = new ManagedStackService({
    logger: silentLogger,
    jobs: new JobRegistry({ logger: silentLogger }),
    loadSettingsImpl: async () => ({ ...stack.settings, autoRevert: overrides.autoRevert === true }),
    readContainerImageIdImpl: async () => overrides.previousImageId ?? "sha256:previous",
    upgradeServiceImpl: async () => {
      calls.push("pull+up");
      return overrides.upgradeResult || { ...ok, phase: "up" };
    },
    verifyServiceHealthImpl: async () => {
      calls.push("verify");
      // The revert's own verification is the second call; it always comes back.
      const first = calls.filter((call) => call === "verify").length === 1;
      return first ? (overrides.health || { outcome: HEALTH_OUTCOME.VERIFIED, reason: "healthy" }) : { outcome: HEALTH_OUTCOME.VERIFIED, reason: "healthy" };
    },
    generateAndDeployImpl: async () => {
      calls.push("compose-up");
      return overrides.deployResult || ok;
    },
    findRollbackPointImpl: async () => point,
    imageExistsLocallyImpl: async () => overrides.imageMissing !== true,
    readUpdateStateImpl: async () => stored,
    writeUpdateStateImpl: async (next) => {
      writes.push(JSON.parse(JSON.stringify(next)));
      return Object.assign(stored, next);
    },
    appendActivityImpl: async (entry) => {
      activity.push(entry);
    },
    ...overrides.impls
  });

  return { calls, writes, activity, stored, service };
}

const UNHEALTHY = { outcome: HEALTH_OUTCOME.FAILED, reason: "Container is exited." };

test("a revert whose previous image does not come back either is reported as down, not as recovered", async (t) => {
  // A migration the new image ran on the database, say: going back does not
  // bring it back. The pin is right — it keeps the nightly run away — but
  // "reverted, ok" would report a service that is down as recovered.
  const stack = await createStack(t);
  const { calls, stored, activity, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    impls: {
      verifyServiceHealthImpl: async () => {
        calls.push("verify");
        return { outcome: HEALTH_OUTCOME.FAILED, reason: "Container is exited." };
      }
    }
  });

  const result = await service.upgradeManagedService("radarr");

  assert.deepEqual(calls, ["pull+up", "verify", "compose-up", "verify"]);
  assert.equal(result.ok, false);
  assert.equal(result.reverted, true, "the pin is in place");
  assert.match(result.error, /Reverted to linuxserver\/radarr:latest, but that did not come back either/);
  assert.equal(stored.radarr.status, "rolled-back");
  assert.match(activity.at(-1).message, /did not come back either/);
});

test("a compose-up that never started the new image is left retryable, not recorded as current", async (t) => {
  // Two ways to get here — revert off, and revert on but refused — and both
  // used to write "current" for a container that does not exist, which
  // Upgrade All then skips forever.
  for (const overrides of [
    { autoRevert: false },
    { autoRevert: true, imageMissing: true }
  ]) {
    const stack = await createStack(t);
    const { stored, writes, service } = createUpgradeService(t, stack, {
      ...overrides,
      stored: { radarr: { status: "ready", checkedAt: "2026-09-07T00:00:00.000Z" } },
      upgradeResult: { ok: false, phase: "up", stdout: "", stderr: "no such image", code: 1 }
    });

    const result = await service.upgradeManagedService("radarr");

    assert.equal(result.ok, false);
    assert.equal(result.reverted, false);
    assert.equal(stored.radarr.status, "ready", JSON.stringify(overrides));
    assert.equal(writes.length, 0, "nothing was written down as current");
  }
});

test("a revert whose deploy fails puts the compose file back on the tag", async (t) => {
  // restoreImage pins the digest before it deploys. If the deploy fails the
  // pin must not outlive it, or the next ordinary deploy targets a revert
  // that never happened.
  const stack = await createStack(t);
  const { stored, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    health: UNHEALTHY,
    deployResult: { ok: false, stdout: "", stderr: "port is already allocated", code: 1 }
  });

  const result = await service.upgradeManagedService("radarr");

  assert.equal(result.reverted, false);
  assert.match(result.error, /Revert was not possible: port is already allocated/);
  assert.equal(await readComposeImage(stack.settings.services.radarr), "linuxserver/radarr:latest");
  assert.notEqual(stored.radarr?.status, "rolled-back");
});

test("an upgrade that comes back healthy records when it happened and never reverts", async (t) => {
  const stack = await createStack(t);
  const { calls, stored, service } = createUpgradeService(t, stack, { autoRevert: true });

  const result = await service.upgradeManagedService("radarr");

  assert.deepEqual(calls, ["pull+up", "verify"]);
  assert.equal(result.ok, true);
  assert.equal(result.reverted, false);
  assert.equal(stored.radarr.status, "current");
  assert.ok(stored.radarr.upgradedAt, "the upgrade time is recorded");
  // Nothing was pinned: the compose file still names the tag.
  assert.equal(await readComposeImage(stack.settings.services.radarr), "linuxserver/radarr:latest");
});

test("with auto-revert off, an upgrade that does not come back is reported and left running", async (t) => {
  const stack = await createStack(t);
  const { calls, stored, activity, service } = createUpgradeService(t, stack, { autoRevert: false, health: UNHEALTHY });

  const result = await service.upgradeManagedService("radarr");

  // Today's behaviour, exactly: no compose-up, no pin, the failure is the report.
  assert.deepEqual(calls, ["pull+up", "verify"]);
  assert.equal(result.ok, false);
  assert.equal(result.reverted, false);
  assert.equal(result.error, "Container is exited.");
  assert.equal(await readComposeImage(stack.settings.services.radarr), "linuxserver/radarr:latest");
  assert.equal(stored.radarr.status, "current");
  const last = activity.at(-1);
  assert.match(last.message, /did not come back healthy/);
  assert.doesNotMatch(last.message, /Reverted/);
});

test("with auto-revert on, an upgrade that does not come back is pinned back to the previous image", async (t) => {
  const stack = await createStack(t);
  const { calls, stored, activity, service } = createUpgradeService(t, stack, { autoRevert: true, health: UNHEALTHY });

  const result = await service.upgradeManagedService("radarr");

  // Verified, found unhealthy, put back, verified again.
  assert.deepEqual(calls, ["pull+up", "verify", "compose-up", "verify"]);
  assert.equal(result.ok, false);
  assert.equal(result.reverted, true);
  assert.equal(result.revertedTo, "linuxserver/radarr@sha256:previous");
  assert.match(result.error, /Reverted to linuxserver\/radarr:latest/);
  // The digest, never the tag: the tag now resolves to the image that failed.
  assert.equal(await readComposeImage(stack.settings.services.radarr), "linuxserver/radarr@sha256:previous");
  assert.equal(stored.radarr.status, "rolled-back");
  assert.match(activity.at(-1).message, /Reverted to/);
  assert.equal(activity.at(-1).details.reverted, true);
});

test("with auto-revert on, a healthy upgrade leaves the compose file alone", async (t) => {
  const stack = await createStack(t);
  const { calls, service } = createUpgradeService(t, stack, { autoRevert: true });

  await service.upgradeManagedService("radarr");

  assert.ok(!calls.includes("compose-up"), "nothing to put back");
  assert.equal(await readComposeImage(stack.settings.services.radarr), "linuxserver/radarr:latest");
});

test("the update state is never 'current' for an upgrade that was reverted", async (t) => {
  // recordFreshImageState used to run before the health check, so a reverted
  // upgrade was written down as current on its way to being undone.
  const stack = await createStack(t);
  const { writes, service } = createUpgradeService(t, stack, { autoRevert: true, health: UNHEALTHY });

  await service.upgradeManagedService("radarr");

  assert.ok(writes.length > 0);
  assert.ok(writes.every((write) => write.radarr?.status !== "current"), `wrote: ${JSON.stringify(writes)}`);
  assert.equal(writes.at(-1).radarr.status, "rolled-back");
});

test("a revert is refused when the previous image is gone from the host", async (t) => {
  const stack = await createStack(t);
  const { calls, stored, service } = createUpgradeService(t, stack, { autoRevert: true, health: UNHEALTHY, imageMissing: true });

  const result = await service.upgradeManagedService("radarr");

  assert.deepEqual(calls, ["pull+up", "verify"]);
  assert.equal(result.reverted, false);
  assert.match(result.error, /no longer on this host/);
  // Nothing was put back, so the failed image is what is running.
  assert.equal(stored.radarr.status, "current");
  assert.equal(await readComposeImage(stack.settings.services.radarr), "linuxserver/radarr:latest");
});

test("a revert is refused when the newest backup is not the image that was running", async (t) => {
  // findRollbackPoint skips the record matching the running image. If the pull
  // changed nothing and the container died anyway, that hands back an older
  // backup — and going back past the previous state is the wrong thing to do
  // silently.
  const stack = await createStack(t);
  const { calls, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    health: UNHEALTHY,
    point: { imageId: "sha256:older", imageRef: "linuxserver/radarr@sha256:older", taggedImage: "linuxserver/radarr:latest" }
  });

  const result = await service.upgradeManagedService("radarr");

  assert.ok(!calls.includes("compose-up"));
  assert.equal(result.reverted, false);
  assert.match(result.error, /does not match the image that was running/);
});

test("an upgrade whose container never starts is reverted like an unhealthy one", async (t) => {
  // A failed `up` means the old container is gone and the new one never ran.
  // That is "did not come up", not "the pull failed".
  const stack = await createStack(t);
  const { calls, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    upgradeResult: { ok: false, phase: "up", stdout: "", stderr: "no such image", code: 1 }
  });

  const result = await service.upgradeManagedService("radarr");

  // No first verification: there is nothing running to verify.
  assert.deepEqual(calls, ["pull+up", "compose-up", "verify"]);
  assert.equal(result.reverted, true);
  assert.match(result.error, /could not start the new container/);
});

test("a failed pull neither reverts nor claims the service is current", async (t) => {
  const stack = await createStack(t);
  const { calls, stored, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    upgradeResult: { ok: false, phase: "pull", stdout: "", stderr: "manifest unknown", code: 1 }
  });

  const result = await service.upgradeManagedService("radarr");

  assert.deepEqual(calls, ["pull+up"]);
  assert.equal(result.ok, false);
  assert.equal(result.reverted, false);
  assert.equal(stored.radarr, undefined, "nothing changed, so nothing is recorded");
});

test("an update check keeps the last upgrade time", async (t) => {
  const stack = await createStack(t);
  const stored = { radarr: { status: "current", checkedAt: "2026-09-01T00:00:00.000Z", upgradedAt: "2026-08-30T03:04:05.000Z" } };
  const { service } = createUpgradeService(t, stack, {
    stored,
    impls: { checkForUpdatesImpl: async () => ({ ok: true, updateStatus: "ready", stdout: "", stderr: "" }) }
  });

  await service.checkServiceUpdate("radarr");

  assert.equal(stored.radarr.status, "ready");
  assert.equal(stored.radarr.upgradedAt, "2026-08-30T03:04:05.000Z", "a check must not erase when the app was last upgraded");
});

test("Upgrade All reverts an unhealthy service when auto-revert is on and keeps going", async (t) => {
  const stack = await createStackWith(t, ["radarr", "sonarr"]);
  const attempted = [];
  const pinned = [];
  const service = new ManagedStackService({
    logger: silentLogger,
    jobs: new JobRegistry({ logger: silentLogger }),
    loadSettingsImpl: async () => ({ ...stack.settings, autoRevert: true }),
    readContainerImageIdImpl: async () => "sha256:previous",
    upgradeServiceImpl: async (_s, svc) => {
      attempted.push(svc.id);
      return { ok: true, phase: "up", stdout: "", stderr: "" };
    },
    // Radarr comes up broken; everything else, including the revert's own
    // check, comes back fine.
    verifyServiceHealthImpl: async (_s, svc) => {
      const firstLook = svc.id === "radarr" && !pinned.includes("radarr");
      return firstLook
        ? { outcome: HEALTH_OUTCOME.FAILED, reason: "Container is exited." }
        : { outcome: HEALTH_OUTCOME.VERIFIED, reason: "healthy" };
    },
    findRollbackPointImpl: async (_s, svc) => ({
      imageId: "sha256:previous",
      imageRef: `linuxserver/${svc.id}@sha256:previous`,
      taggedImage: `linuxserver/${svc.id}:latest`
    }),
    imageExistsLocallyImpl: async () => true,
    generateAndDeployImpl: async (_s, svc) => {
      pinned.push(svc.id);
      return { ok: true, stdout: "", stderr: "", code: 0 };
    },
    readUpdateStateImpl: async () => ({ radarr: { status: "ready" }, sonarr: { status: "ready" } }),
    writeUpdateStateImpl: async () => ({}),
    appendActivityImpl: async () => {}
  });

  const job = await settleJobById(service, (await service.startUpgradeAll().create()).id);

  // Both were attempted; only the broken one was put back.
  assert.deepEqual(attempted, ["radarr", "sonarr"]);
  assert.deepEqual(pinned, ["radarr"]);
  assert.equal(job.result.upgraded, 1);
  assert.equal(job.result.failed, 1);
  const radarr = job.steps.find((step) => step.name === "radarr");
  assert.equal(radarr.status, STEP_STATUS.FAILED);
  assert.match(radarr.error, /Reverted to linuxserver\/radarr:latest/);
  assert.equal(job.steps.find((step) => step.name === "sonarr").status, STEP_STATUS.SUCCEEDED);
  assert.equal(job.result.results.find((r) => r.serviceId === "radarr").reverted, true);
});
