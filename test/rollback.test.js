import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";

import { ManagedStackService } from "../src/lib/app-services/managed-stack-service.js";
import { JOB_STATUS, JobRegistry, STEP_STATUS } from "../src/lib/jobs.js";
import { HEALTH_OUTCOME } from "../src/lib/health.js";
import { backupService, findRollbackPoint } from "../src/lib/runtime.js";
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
  // Radarr declares a /config volume, and every backup since snapshots existed
  // captures one, so a rollback point with a snapshot is the realistic default.
  // Without it a revert now declines rather than stranding a stateful app on a
  // database its older version cannot read, which is its own test below.
  const point = overrides.point === undefined
    ? {
        imageId: "sha256:previous",
        imageRef: "linuxserver/radarr@sha256:previous",
        taggedImage: "linuxserver/radarr:latest",
        backupDir: "/stacks/.keelarr-backups/radarr/2026-09-25T06-00-45-961Z",
        backedUpAt: "2026-09-25T06:00:45.961Z",
        configSnapshot: { file: "config-snapshot.tar.gz", mountType: "bind", mountSource: "/config/radarr" }
      }
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
      // A real verified result reports the running container it observed, and
      // the revert reads that status to decide what to report and record.
      const healthy = { outcome: HEALTH_OUTCOME.VERIFIED, reason: "healthy", status: "running" };
      return first ? (overrides.health || healthy) : healthy;
    },
    generateAndDeployImpl: async () => {
      calls.push("compose-up");
      return overrides.deployResult || ok;
    },
    findRollbackPointImpl: async () => point,
    imageExistsLocallyImpl: async () => overrides.imageMissing !== true,
    // The restore half of a revert, stubbed to succeed and deliberately not
    // recorded in `calls`: the tests below that care about the order of the
    // stop and the restore record them themselves, and the ones that only care
    // that a revert happened keep asserting the sequence they always did.
    readConfigMountSourceImpl: async () => ({ type: "bind", source: "/config/radarr" }),
    composeDownImpl: async () => ok,
    restoreConfigSnapshotImpl: async () => ({ ok: true }),
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

// A real verifyServiceHealth result always carries the status it observed, and
// the revert reads it to decide whether the new image is actually running.
const UNHEALTHY = { outcome: HEALTH_OUTCOME.FAILED, reason: "Container is exited.", status: "exited" };
// Up, but its healthcheck never passed. Still running, unlike the above.
const UNHEALTHY_RUNNING = { outcome: HEALTH_OUTCOME.FAILED, reason: "Container healthcheck reports unhealthy.", status: "running" };

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

test("a revert whose deploy fails and whose pin cannot be cleared says the pin is still there", async (t) => {
  // Claiming "not pinned" when the compose file still names the digest
  // would send the next ordinary deploy at a revert that never ran.
  const stack = await createStack(t);
  let composeWrites = 0;
  const { service } = createUpgradeService(t, stack, {
    autoRevert: true,
    health: UNHEALTHY,
    deployResult: { ok: false, stdout: "", stderr: "port is already allocated", code: 1 },
    impls: {
      setComposeImageImpl: async (service, imageRef) => {
        composeWrites += 1;
        // The pin goes in for real; putting the tag back is what fails.
        if (composeWrites > 1) {
          throw new Error("EROFS: read-only file system");
        }
        await setComposeImage(service, imageRef);
      }
    }
  });

  const result = await service.upgradeManagedService("radarr");

  assert.equal(result.reverted, false);
  assert.match(result.error, /Revert was not possible: port is already allocated\. The compose file is still pinned to linuxserver\/radarr@sha256:previous/);
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
  // The health check found the container exited, so nothing is running and the
  // old status stays: an absent service recorded as current reads as done to
  // both the dashboard and Upgrade All.
  assert.equal(stored.radarr?.status, undefined);
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
      taggedImage: `linuxserver/${svc.id}:latest`,
      backupDir: `/stacks/.keelarr-backups/${svc.id}/2026-09-25T06-00-45-961Z`,
      backedUpAt: "2026-09-25T06:00:45.961Z",
      configSnapshot: { file: "config-snapshot.tar.gz", mountType: "bind", mountSource: `/config/${svc.id}` }
    }),
    imageExistsLocallyImpl: async () => true,
    // Both declare a /config volume, so the revert puts the database back with
    // the image rather than declining.
    readConfigMountSourceImpl: async (_s, svc) => ({ type: "bind", source: `/config/${svc.id}` }),
    composeDownImpl: async () => ({ ok: true, stdout: "", stderr: "", code: 0 }),
    restoreConfigSnapshotImpl: async () => ({ ok: true }),
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

// --- an automatic revert must not strand the app on a newer database ------------

const PREVIOUS_WITH_SNAPSHOT = {
  imageId: "sha256:previous",
  imageRef: "linuxserver/radarr@sha256:previous",
  taggedImage: "linuxserver/radarr:latest",
  backupDir: "/stacks/.keelarr-backups/radarr/2026-09-25T06-00-45-961Z",
  backedUpAt: "2026-09-25T06:00:45.961Z",
  configSnapshot: { file: "config-snapshot.tar.gz", mountType: "bind", mountSource: "/config/radarr" }
};

/**
 * The Trailarr outage in one test. The new image migrated the database forward,
 * the health check gave up, and the revert put the old image back on top of the
 * new schema — so the older binary could not read it and parked itself. Going
 * back has to take the database with it.
 */
test("an automatic revert restores the config snapshot before putting the image back", async (t) => {
  const stack = await createStack(t);
  const restores = [];
  const { calls, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    health: UNHEALTHY,
    point: PREVIOUS_WITH_SNAPSHOT,
    impls: {
      readConfigMountSourceImpl: async () => ({ type: "bind", source: "/config/radarr" }),
      composeDownImpl: async () => {
        calls.push("compose-down");
        return { ok: true, stdout: "", stderr: "", code: 0 };
      },
      restoreConfigSnapshotImpl: async (_s, _svc, dir, opts) => {
        calls.push("restore-config");
        restores.push({ dir, mount: opts.mount });
        return { ok: true };
      }
    }
  });

  const result = await service.upgradeManagedService("radarr");

  // The order is the point: stopped, database put back, then the image.
  assert.deepEqual(calls, ["pull+up", "verify", "compose-down", "restore-config", "compose-up", "verify"]);
  assert.equal(result.reverted, true);
  assert.deepEqual(restores, [{ dir: PREVIOUS_WITH_SNAPSHOT.backupDir, mount: { type: "bind", source: "/config/radarr" } }]);
  assert.equal(await readComposeImage(stack.settings.services.radarr), "linuxserver/radarr@sha256:previous");
});

test("a revert says in the record that the database went back with the image", async (t) => {
  const stack = await createStack(t);
  const { activity, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    health: UNHEALTHY,
    point: PREVIOUS_WITH_SNAPSHOT,
    impls: {
      readConfigMountSourceImpl: async () => ({ type: "bind", source: "/config/radarr" }),
      composeDownImpl: async () => ({ ok: true, stdout: "", stderr: "", code: 0 }),
      restoreConfigSnapshotImpl: async () => ({ ok: true })
    }
  });

  const result = await service.upgradeManagedService("radarr");

  assert.equal(result.reverted, true);
  // An operator reading this the next morning needs to know it was a real
  // revert and not a reset to an older binary over a newer database.
  assert.match(activity.at(-1).message, /configuration from 2026-09-25T06:00:45\.961Z was restored with it/);
});

test("a stateful service with no config snapshot is left on the new image rather than bricked", async (t) => {
  const stack = await createStack(t);
  const { calls, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    health: UNHEALTHY,
    // A backup that captured the image but not the database — the snapshot
    // failed, or the backup predates snapshots entirely.
    point: { imageId: "sha256:previous", imageRef: "linuxserver/radarr@sha256:previous", taggedImage: "linuxserver/radarr:latest" },
    impls: {
      readConfigMountSourceImpl: async () => ({ type: "bind", source: "/config/radarr" })
    }
  });

  const result = await service.upgradeManagedService("radarr");

  // Nothing was put back: the new image is unhealthy but at least consistent
  // with the schema on disk, which beats an older image that cannot read it.
  assert.deepEqual(calls, ["pull+up", "verify"]);
  assert.equal(result.reverted, false);
  assert.match(result.error, /keeps state in \/config\/radarr/);
  assert.equal(await readComposeImage(stack.settings.services.radarr), "linuxserver/radarr:latest");
});

test("a revert whose config restore fails brings the service back up on the new image", async (t) => {
  const stack = await createStack(t);
  const { calls, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    health: UNHEALTHY,
    point: PREVIOUS_WITH_SNAPSHOT,
    impls: {
      readConfigMountSourceImpl: async () => ({ type: "bind", source: "/config/radarr" }),
      composeDownImpl: async () => {
        calls.push("compose-down");
        return { ok: true, stdout: "", stderr: "", code: 0 };
      },
      restoreConfigSnapshotImpl: async () => ({ ok: false, reason: "tar failed" })
    }
  });

  const result = await service.upgradeManagedService("radarr");

  // It was taken down to restore, the restore failed, so it goes back up on the
  // image it was upgraded to rather than being left off — and that recovery is
  // checked, because `compose up` exiting zero is not proof it stayed up.
  assert.deepEqual(calls, ["pull+up", "verify", "compose-down", "compose-up", "verify"]);
  assert.equal(result.reverted, false);
  assert.match(result.error, /could not be restored/);
  assert.equal(await readComposeImage(stack.settings.services.radarr), "linuxserver/radarr:latest");
});

test("a stateless service with no config snapshot is still reverted on the image alone", async (t) => {
  const stack = await createStack(t);
  // FlareSolverr's shape: it answers a challenge and forgets, so the catalog
  // declares no volumes at all and there is no database to mismatch.
  const stateless = { ...stack.settings, services: { radarr: { ...stack.settings.services.radarr, volumes: [] } } };
  const { calls, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    health: UNHEALTHY,
    point: { imageId: "sha256:previous", imageRef: "linuxserver/radarr@sha256:previous", taggedImage: "linuxserver/radarr:latest" },
    impls: {
      loadSettingsImpl: async () => ({ ...stateless, autoRevert: true }),
      readConfigMountSourceImpl: async () => null
    }
  });

  const result = await service.upgradeManagedService("radarr");

  // Nothing stateful to mismatch, so the old behaviour is right here: no stop,
  // no restore, just the image put back.
  assert.deepEqual(calls, ["pull+up", "verify", "compose-up", "verify"]);
  assert.equal(result.reverted, true);
  assert.equal(await readComposeImage(stack.settings.services.radarr), "linuxserver/radarr@sha256:previous");
});

test("an unreadable /config mount is not mistaken for a stateless service", async (t) => {
  const stack = await createStack(t);
  const { calls, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    health: UNHEALTHY,
    point: { imageId: "sha256:previous", imageRef: "linuxserver/radarr@sha256:previous", taggedImage: "linuxserver/radarr:latest" },
    // docker inspect failed, or the failed upgrade left no container to inspect.
    // Indistinguishable from "no /config" in the return value, so the stack
    // definition decides — and Radarr declares one.
    impls: { readConfigMountSourceImpl: async () => null }
  });

  const result = await service.upgradeManagedService("radarr");

  assert.deepEqual(calls, ["pull+up", "verify"], "nothing was put back");
  assert.equal(result.reverted, false);
  assert.match(result.error, /keeps state in its config directory/);
  assert.equal(await readComposeImage(stack.settings.services.radarr), "linuxserver/radarr:latest");
});

test("a revert does not restore over an app it could not stop", async (t) => {
  const stack = await createStack(t);
  const { calls, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    health: UNHEALTHY,
    impls: {
      composeDownImpl: async () => {
        calls.push("compose-down");
        return { ok: false, stdout: "", stderr: "error during connect: container is restarting", code: 1 };
      },
      restoreConfigSnapshotImpl: async () => {
        calls.push("restore-config");
        return { ok: true };
      }
    }
  });

  const result = await service.upgradeManagedService("radarr");

  // compose down reports failure by returning it, not by throwing. Carrying on
  // would race `rm -rf /config` against a process still writing to it.
  assert.ok(!calls.includes("restore-config"), "the destructive restore never ran");
  assert.equal(result.reverted, false);
  assert.match(result.error, /could not be stopped/);
  assert.equal(await readComposeImage(stack.settings.services.radarr), "linuxserver/radarr:latest");
});

test("a failed config restore that cannot be started again says the service is down", async (t) => {
  const stack = await createStack(t);
  const { service } = createUpgradeService(t, stack, {
    autoRevert: true,
    health: UNHEALTHY,
    impls: {
      restoreConfigSnapshotImpl: async () => ({ ok: false, reason: "tar failed" }),
      // Stopped, the restore failed, and the recovery deploy fails too.
      generateAndDeployImpl: async () => ({ ok: false, stdout: "", stderr: "no such image", code: 1 })
    }
  });

  const result = await service.upgradeManagedService("radarr");

  // Reporting this as "left running" would be a lie: it was stopped to restore,
  // the restore failed, and it did not come back.
  assert.equal(result.reverted, false);
  assert.match(result.error, /could not be started again afterwards/);
  assert.match(result.error, /is down/);
});

test("a container that never started falls back to the mount the snapshot recorded", async (t) => {
  const stack = await createStack(t);
  const restores = [];
  const { calls, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    // `compose up` never started anything, so there is nothing to inspect.
    upgradeResult: { ok: false, phase: "up", stdout: "", stderr: "no such image" },
    impls: {
      readConfigMountSourceImpl: async () => null,
      composeDownImpl: async () => {
        calls.push("compose-down");
        return { ok: true, stdout: "", stderr: "", code: 0 };
      },
      restoreConfigSnapshotImpl: async (_s, _svc, _dir, opts) => {
        restores.push(opts.mount);
        return { ok: true };
      }
    }
  });

  const result = await service.upgradeManagedService("radarr");

  // This is the failure a revert exists for, so refusing for want of a mount
  // would be the worst possible moment to give up. The snapshot recorded the
  // mount it captured moments before the upgrade.
  assert.deepEqual(restores, [{ type: "bind", source: "/config/radarr" }]);
  assert.equal(result.reverted, true);
  assert.equal(await readComposeImage(stack.settings.services.radarr), "linuxserver/radarr@sha256:previous");
});

test("the restore clears by the exclusions recorded with the snapshot, not today's list", async (t) => {
  const stack = await createStack(t);
  const seen = [];
  const { service } = createUpgradeService(t, stack, {
    autoRevert: true,
    health: UNHEALTHY,
    point: {
      imageId: "sha256:previous",
      imageRef: "linuxserver/radarr@sha256:previous",
      taggedImage: "linuxserver/radarr:latest",
      backupDir: "/stacks/.keelarr-backups/radarr/old",
      backedUpAt: "2026-08-01T00:00:00.000Z",
      // An older Keelarr kept a shorter list.
      configSnapshot: { file: "config-snapshot.tar.gz", mountType: "bind", mountSource: "/config/radarr", excluded: ["./[Ll]ogs"] }
    },
    impls: {
      restoreConfigSnapshotImpl: async (_s, _svc, _dir, opts) => {
        seen.push(opts.excludes);
        return { ok: true };
      }
    }
  });

  await service.upgradeManagedService("radarr");

  // Clearing by today's list would delete a directory that archive kept, or
  // keep one it captured.
  assert.deepEqual(seen, [["./[Ll]ogs"]]);
});

test("a stop that fails and will not restart records the service as down, not current", async (t) => {
  const stack = await createStack(t);
  const { stored, activity, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    health: UNHEALTHY,
    stored: { radarr: { status: "ready" } },
    impls: {
      composeDownImpl: async () => ({ ok: false, stdout: "", stderr: "container is restarting", code: 1 }),
      generateAndDeployImpl: async () => ({ ok: false, stdout: "", stderr: "port is already allocated", code: 1 })
    }
  });

  const result = await service.upgradeManagedService("radarr");

  // `down` can fail having already removed the container. Recording the new
  // image as current would leave Upgrade All and the dashboard treating an
  // absent service as done.
  assert.equal(result.reverted, false);
  assert.match(result.error, /is down/);
  assert.notEqual(stored.radarr.status, "current", "a service that is down is not current");
  assert.equal(activity.at(-1).details.running, false);
});

test("a previous image that will not deploy is followed by an attempt to bring the new one back", async (t) => {
  const stack = await createStack(t);
  let deploys = 0;
  const { service } = createUpgradeService(t, stack, {
    autoRevert: true,
    health: UNHEALTHY,
    impls: {
      // The revert's own deploy fails; the recovery deploy after unpinning works.
      generateAndDeployImpl: async () => {
        deploys += 1;
        return deploys === 1
          ? { ok: false, stdout: "", stderr: "manifest unknown", code: 1 }
          : { ok: true, stdout: "", stderr: "", code: 0 };
      }
    }
  });

  const result = await service.upgradeManagedService("radarr");

  // Restoring the config stopped the service, so without this it would be left
  // off with a compose file pointing at a perfectly startable image.
  assert.equal(deploys, 2, "it tried to bring the new image back after unpinning");
  assert.equal(result.reverted, false);
  assert.equal(await readComposeImage(stack.settings.services.radarr), "linuxserver/radarr:latest");
});

test("a revert that fails both ways says the service is down", async (t) => {
  const stack = await createStack(t);
  const { activity, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    health: UNHEALTHY,
    impls: {
      generateAndDeployImpl: async () => ({ ok: false, stdout: "", stderr: "manifest unknown", code: 1 })
    }
  });

  const result = await service.upgradeManagedService("radarr");

  assert.match(result.error, /could not be started again afterwards either/);
  assert.equal(activity.at(-1).details.running, false);
});

test("a service the health check found exited is not recorded as current", async (t) => {
  const stack = await createStack(t);
  const { stored, activity, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    health: UNHEALTHY,
    stored: { radarr: { status: "ready" } },
    point: { imageId: "sha256:previous", imageRef: "linuxserver/radarr@sha256:previous", taggedImage: "linuxserver/radarr:latest" }
  });

  const result = await service.upgradeManagedService("radarr");

  // No snapshot and Radarr declares /config, so the revert declines — and the
  // container is exited, so the image it declined to replace is not running.
  assert.equal(result.reverted, false);
  assert.equal(stored.radarr.status, "ready", "left for Upgrade All to pick up again");
  assert.equal(activity.at(-1).details.running, false);
});

test("a service that is up but unhealthy is still recorded as current when a revert is declined", async (t) => {
  const stack = await createStack(t);
  const { stored, activity, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    health: UNHEALTHY_RUNNING,
    stored: { radarr: { status: "ready" } },
    point: { imageId: "sha256:previous", imageRef: "linuxserver/radarr@sha256:previous", taggedImage: "linuxserver/radarr:latest" }
  });

  const result = await service.upgradeManagedService("radarr");

  // The new image is what is running, badly. That is true of the image, and the
  // activity entry is what carries the failure.
  assert.equal(result.reverted, false);
  assert.equal(stored.radarr.status, "current");
  assert.equal(activity.at(-1).details.running, true);
});

test("a recovery deploy that exits zero but does not stay up is reported as down", async (t) => {
  const stack = await createStack(t);
  const { service } = createUpgradeService(t, stack, {
    autoRevert: true,
    health: UNHEALTHY,
    impls: {
      restoreConfigSnapshotImpl: async () => ({ ok: false, reason: "tar failed" }),
      // Compose is happy; the container exits a second later.
      verifyServiceHealthImpl: async () => ({ outcome: HEALTH_OUTCOME.FAILED, reason: "Container is exited.", status: "exited" })
    }
  });

  const result = await service.upgradeManagedService("radarr");

  // `compose up` returning zero is not proof of a running service, which is why
  // the ordinary upgrade path health-checks a deploy it knows succeeded.
  assert.match(result.error, /could not be started again afterwards/);
  assert.match(result.error, /is down/);
});

test("a compose file that cannot be written does not leave the revert silent", async (t) => {
  const stack = await createStack(t);
  const { activity, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    health: UNHEALTHY,
    impls: {
      setComposeImageImpl: async () => {
        throw new Error("EACCES: permission denied, open 'compose.yml'");
      }
    }
  });

  const result = await service.upgradeManagedService("radarr");

  // It rejects rather than returning, and the service has already been stopped
  // to restore its database, so an unhandled throw left it down in silence.
  assert.equal(result.reverted, false);
  assert.match(result.error, /permission denied/);
  assert.equal(activity.at(-1).kind, "upgrade");
  assert.equal(activity.at(-1).level, "error");
});

test("a fallback onto the new image records it as current", async (t) => {
  const stack = await createStack(t);
  let deploys = 0;
  const { stored, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    health: UNHEALTHY,
    stored: { radarr: { status: "ready" } },
    impls: {
      generateAndDeployImpl: async () => {
        deploys += 1;
        return deploys === 1
          ? { ok: false, stdout: "", stderr: "manifest unknown", code: 1 }
          : { ok: true, stdout: "", stderr: "", code: 0 };
      }
    }
  });

  await service.upgradeManagedService("radarr");

  // The tag is running again, so it is current. Left as "ready", Upgrade All
  // would start the same upgrade and the same revert over immediately.
  assert.equal(stored.radarr.status, "current");
});

test("a recovery that comes back running but unhealthy is reported as running", async (t) => {
  const stack = await createStack(t);
  const { stored, activity, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    health: UNHEALTHY,
    stored: { radarr: { status: "ready" } },
    impls: {
      restoreConfigSnapshotImpl: async () => ({ ok: false, reason: "tar failed" }),
      // Up, but its healthcheck never passes: FAILED with status "running".
      verifyServiceHealthImpl: async () => UNHEALTHY_RUNNING
    }
  });

  const result = await service.upgradeManagedService("radarr");

  // "Running but unhealthy" is the state the refusal path already records as
  // current. Collapsing it to "down" here would record the same situation two
  // different ways depending on which route reached it.
  assert.equal(activity.at(-1).details.running, true);
  assert.ok(!/is down/.test(result.error), `should not claim it is down: ${result.error}`);
  assert.equal(stored.radarr.status, "current");
});

test("a revert that comes back running but unhealthy does not claim it never came back", async (t) => {
  const stack = await createStack(t);
  const { activity, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    impls: {
      // The new image is unhealthy and so is the old one, but the old one is up.
      verifyServiceHealthImpl: async () => UNHEALTHY_RUNNING
    }
  });

  const result = await service.upgradeManagedService("radarr");

  // "did not come back either" of a running container is simply wrong, and it
  // is the sentence an operator reads first.
  assert.match(activity.at(-1).message, /running but still not healthy/);
  assert.equal(activity.at(-1).details.running, true);
  // Both operator-facing strings have to agree: the wrapper upgradeOne builds
  // must not introduce it as a service that did not come back and then quote a
  // reason saying it is running.
  assert.match(result.error, /but it is still not healthy/);
  assert.ok(!/did not come back either/.test(result.error), `contradicts itself: ${result.error}`);
  assert.match(result.error, /It is running, but not healthy/);
  // Still not a recovery: an app on its old image with a failing healthcheck is
  // not fixed, so revertedDown stays true and the nightly summary counts it with
  // the failures. That classification is unchanged here and covered by
  // "a reverted app that stays down is counted with the failures" in
  // auto-update.test.js; upgradeManagedService does not surface the field.
  assert.equal(result.reverted, true);
});

test("a revert whose previous image is genuinely down still says so", async (t) => {
  const stack = await createStack(t);
  const { activity, service } = createUpgradeService(t, stack, {
    autoRevert: true,
    impls: { verifyServiceHealthImpl: async () => UNHEALTHY }
  });

  const result = await service.upgradeManagedService("radarr");

  assert.match(activity.at(-1).message, /did not come back either/);
  assert.match(result.error, /did not come back either/);
  assert.equal(activity.at(-1).details.running, false);
  assert.equal(result.reverted, true);
});

// --- a rollback must not prune the backup it is about to restore from ----------

test("a rollback protects its own restore point from retention", async (t) => {
  const stack = await createStack(t);
  const stamp = "2026-08-03T00-00-00-000Z";
  await writeBackup(stack.root, stamp, {
    imageId: "sha256:previous",
    imageRepoDigest: "linuxserver/radarr@sha256:previous",
    configSnapshot: { file: "config-snapshot.tar.gz", mountType: "bind", mountSource: "/config/radarr" }
  });

  const backupOptions = [];
  const { service } = createService(t, stack, {
    impls: {
      readConfigMountSourceImpl: async () => ({ type: "bind", source: "/config/radarr" }),
      composeDownImpl: async () => ({ ok: true, stdout: "", stderr: "" }),
      restoreConfigSnapshotImpl: async () => ({ ok: true }),
      backupServiceImpl: async (_s, _svc, options) => {
        backupOptions.push(options);
        return { backupDir: "/backups/radarr/newer", rollback: {} };
      }
    }
  });

  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr", restoreConfig: true }));

  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);
  // The restore point is resolved in preflight and the backup written here is
  // newer, so at the default retention of 1 pruning would delete it one step
  // before restore-config reads its snapshot out of it.
  assert.equal(backupOptions.length, 1);
  assert.deepEqual(
    backupOptions[0].protect,
    [path.join(stack.root, ".keelarr-backups", "radarr", stamp)],
    "the backup step tells pruning to spare the restore point"
  );
});

test("a rollback's restore point still exists when the restore step reads it", async (t) => {
  const stack = await createStack(t);
  const stamp = "2026-08-03T00-00-00-000Z";
  const pointDir = await writeBackup(stack.root, stamp, {
    imageId: "sha256:previous",
    imageRepoDigest: "linuxserver/radarr@sha256:previous",
    configSnapshot: { file: "config-snapshot.tar.gz", mountType: "bind", mountSource: "/config/radarr" }
  });
  await writeFile(path.join(pointDir, "config-snapshot.tar.gz"), "archive", "utf8");

  let snapshotPresent = null;
  const { service } = createService(t, stack, {
    impls: {
      // The real backupService, so retention actually runs: stubbing it is why
      // this went unnoticed, since the stub has no side effect to catch. Only
      // the docker-dependent snapshot and daemon calls are kept out of it.
      backupServiceImpl: async (settings, svc, options) =>
        backupService({ ...settings, dockerBin: "/nonexistent/docker" }, svc, {
          ...options,
          snapshotConfigImpl: async () => ({ ok: false, skipped: true, reason: "not under test" })
        }),
      readConfigMountSourceImpl: async () => ({ type: "bind", source: "/config/radarr" }),
      composeDownImpl: async () => ({ ok: true, stdout: "", stderr: "" }),
      restoreConfigSnapshotImpl: async (_s, _svc, dir) => {
        snapshotPresent = await stat(path.join(dir, "config-snapshot.tar.gz")).then(() => true, () => false);
        return { ok: true };
      }
    }
  });

  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr", restoreConfig: true }));

  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);
  // At the default retention of 1, the backup this rollback writes is newer than
  // the point it restores from, so pruning deleted that point and restore-config
  // read a directory that was no longer there — manual rollback could not
  // restore a config snapshot at all on a default install.
  assert.equal(snapshotPresent, true, "the rollback pruned the snapshot it was about to restore");
});

test("an image-only rollback does not hold on to the old restore point", async (t) => {
  const stack = await createStack(t);
  await writeBackup(stack.root, "2026-08-03T00-00-00-000Z", {
    imageId: "sha256:previous",
    imageRepoDigest: "linuxserver/radarr@sha256:previous",
    configSnapshot: { file: "config-snapshot.tar.gz", mountType: "bind", mountSource: "/config/radarr" }
  });

  const backupOptions = [];
  const { service } = createService(t, stack, {
    impls: {
      backupServiceImpl: async (_s, _svc, options) => {
        backupOptions.push(options);
        return { backupDir: "/backups/radarr/newer", rollback: {} };
      }
    }
  });

  // Restore configuration left unchecked, which is the UI default.
  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr" }));

  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);
  // Nothing reads the point after this, so protecting it would leave two
  // backups on disk for an operator whose retention asks for one.
  assert.deepEqual(backupOptions[0].protect, []);
});

test("a rollback whose point has no snapshot does not hold on to it either", async (t) => {
  const stack = await createStack(t);
  await writeBackup(stack.root, "2026-08-03T00-00-00-000Z", {
    imageId: "sha256:previous",
    imageRepoDigest: "linuxserver/radarr@sha256:previous"
  });

  const backupOptions = [];
  const { service } = createService(t, stack, {
    impls: {
      backupServiceImpl: async (_s, _svc, options) => {
        backupOptions.push(options);
        return { backupDir: "/backups/radarr/newer", rollback: {} };
      }
    }
  });

  // Asked for, but there is no snapshot to restore, so restore-config skips.
  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr", restoreConfig: true }));

  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);
  assert.deepEqual(backupOptions[0].protect, []);
  assert.equal(job.steps.find((s) => s.name === "restore-config").status, STEP_STATUS.SKIPPED);
});

test("a non-boolean restore flag is not treated as a request to restore", async (t) => {
  const stack = await createStack(t);
  await writeBackup(stack.root, "2026-08-03T00-00-00-000Z", {
    imageId: "sha256:previous",
    imageRepoDigest: "linuxserver/radarr@sha256:previous",
    configSnapshot: { file: "config-snapshot.tar.gz", mountType: "bind", mountSource: "/config/radarr" }
  });

  const restored = [];
  const backupOptions = [];
  const { service } = createService(t, stack, {
    impls: {
      readConfigMountSourceImpl: async () => ({ type: "bind", source: "/config/radarr" }),
      composeDownImpl: async () => ({ ok: true, stdout: "", stderr: "" }),
      restoreConfigSnapshotImpl: async () => {
        restored.push(1);
        return { ok: true };
      },
      backupServiceImpl: async (_s, _svc, options) => {
        backupOptions.push(options);
        return { backupDir: "/backups/radarr/newer", rollback: {} };
      }
    }
  });

  // The HTTP endpoint does no validation, and restoring replaces the live
  // /config — so the string "false" being truthy must not destroy the
  // configuration a caller meant to keep.
  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr", restoreConfig: "false" }));

  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);
  assert.deepEqual(restored, [], "nothing was restored");
  assert.deepEqual(backupOptions[0].protect, []);
  // And the result must not claim otherwise.
  assert.equal(job.result.configRestored, false);
  assert.equal(job.steps.find((s) => s.name === "restore-config").status, STEP_STATUS.SKIPPED);
});

test("a rollback that restores reports configRestored, and one that cannot does not", async (t) => {
  const stack = await createStack(t);
  await writeBackup(stack.root, "2026-08-03T00-00-00-000Z", {
    imageId: "sha256:previous",
    imageRepoDigest: "linuxserver/radarr@sha256:previous"
  });

  const { service } = createService(t, stack, {
    impls: {
      readConfigMountSourceImpl: async () => ({ type: "bind", source: "/config/radarr" }),
      composeDownImpl: async () => ({ ok: true, stdout: "", stderr: "" }),
      restoreConfigSnapshotImpl: async () => ({ ok: true })
    }
  });

  // Asked for with a real boolean, but the point has no snapshot to give.
  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr", restoreConfig: true }));

  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);
  assert.equal(job.result.configRestored, false, "it cannot restore what was never captured");
});

test("retention catches up once the restored snapshot is no longer needed", async (t) => {
  const stack = await createStack(t);
  await writeBackup(stack.root, "2026-08-03T00-00-00-000Z", {
    imageId: "sha256:previous",
    imageRepoDigest: "linuxserver/radarr@sha256:previous",
    configSnapshot: { file: "config-snapshot.tar.gz", mountType: "bind", mountSource: "/config/radarr" }
  });

  const prunes = [];
  const { service } = createService(t, stack, {
    impls: {
      readConfigMountSourceImpl: async () => ({ type: "bind", source: "/config/radarr" }),
      composeDownImpl: async () => ({ ok: true, stdout: "", stderr: "" }),
      restoreConfigSnapshotImpl: async () => ({ ok: true }),
      pruneServiceBackupsImpl: async (_s, serviceId, options) => {
        prunes.push({ serviceId, protect: options.protect });
        return { pruned: 1, kept: 1 };
      }
    }
  });

  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr", restoreConfig: true }));

  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);
  // A rollback pins the service, and pinned services are skipped by scheduled
  // installs — so the next backup that would have pruned the spare might never
  // come. Retention has to catch up here instead.
  assert.equal(prunes.length, 1);
  assert.equal(prunes[0].serviceId, "radarr");
  assert.equal(prunes[0].protect, undefined, "nothing is protected once the snapshot is consumed");
});

test("an image-only rollback does not need a catch-up prune", async (t) => {
  const stack = await createStack(t);
  await writeBackup(stack.root, "2026-08-03T00-00-00-000Z", {
    imageId: "sha256:previous",
    imageRepoDigest: "linuxserver/radarr@sha256:previous",
    configSnapshot: { file: "config-snapshot.tar.gz" }
  });

  const prunes = [];
  const { service } = createService(t, stack, {
    impls: {
      pruneServiceBackupsImpl: async () => {
        prunes.push(1);
        return { pruned: 0, kept: 1 };
      }
    }
  });

  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr" }));

  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);
  // Nothing was protected, so the backup step's own pass already applied it.
  assert.deepEqual(prunes, []);
});

test("a rollback still succeeds when the catch-up prune fails", async (t) => {
  const stack = await createStack(t);
  await writeBackup(stack.root, "2026-08-03T00-00-00-000Z", {
    imageId: "sha256:previous",
    imageRepoDigest: "linuxserver/radarr@sha256:previous",
    configSnapshot: { file: "config-snapshot.tar.gz", mountType: "bind", mountSource: "/config/radarr" }
  });

  const { service } = createService(t, stack, {
    impls: {
      readConfigMountSourceImpl: async () => ({ type: "bind", source: "/config/radarr" }),
      composeDownImpl: async () => ({ ok: true, stdout: "", stderr: "" }),
      restoreConfigSnapshotImpl: async () => ({ ok: true }),
      pruneServiceBackupsImpl: async () => {
        throw new Error("EACCES: permission denied");
      }
    }
  });

  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr", restoreConfig: true }));

  // The rollback already happened. A spare backup left behind is not a reason to
  // report it as failed.
  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);
  assert.equal(job.result.configRestored, true);
});

test("a config rollback ends with the retention the operator asked for", async (t) => {
  const stack = await createStack(t);
  const stamp = "2026-08-03T00-00-00-000Z";
  const pointDir = await writeBackup(stack.root, stamp, {
    imageId: "sha256:previous",
    imageRepoDigest: "linuxserver/radarr@sha256:previous",
    configSnapshot: { file: "config-snapshot.tar.gz", mountType: "bind", mountSource: "/config/radarr" }
  });
  await writeFile(path.join(pointDir, "config-snapshot.tar.gz"), "archive", "utf8");

  let snapshotPresent = null;
  const { service } = createService(t, stack, {
    impls: {
      // Real backup and real retention, so the whole sequence runs: write a
      // newer backup, spare the point, restore from it, then let retention
      // catch up. Only the docker-dependent pieces are stubbed.
      backupServiceImpl: async (settings, svc, options) =>
        backupService({ ...settings, dockerBin: "/nonexistent/docker" }, svc, {
          ...options,
          snapshotConfigImpl: async () => ({ ok: false, skipped: true, reason: "not under test" })
        }),
      readConfigMountSourceImpl: async () => ({ type: "bind", source: "/config/radarr" }),
      composeDownImpl: async () => ({ ok: true, stdout: "", stderr: "" }),
      restoreConfigSnapshotImpl: async (_s, _svc, dir) => {
        snapshotPresent = await stat(path.join(dir, "config-snapshot.tar.gz")).then(() => true, () => false);
        return { ok: true };
      }
    }
  });

  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr", restoreConfig: true }));

  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);
  // The snapshot was there when it was needed...
  assert.equal(snapshotPresent, true);
  // ...and the spare is gone afterwards, so backupRetention: 1 means one.
  const left = await readdir(path.join(stack.root, ".keelarr-backups", "radarr"));
  assert.equal(left.length, 1, `expected one backup to remain, found ${left.join(", ")}`);
  assert.ok(!left.includes(stamp), "the consumed restore point is the one that went");
});

test("a rollback whose deploy fails keeps the point it would be retried from", async (t) => {
  const stack = await createStack(t);
  const stamp = "2026-08-03T00-00-00-000Z";
  const pointDir = await writeBackup(stack.root, stamp, {
    imageId: "sha256:previous",
    imageRepoDigest: "linuxserver/radarr@sha256:previous",
    configSnapshot: { file: "config-snapshot.tar.gz", mountType: "bind", mountSource: "/config/radarr" }
  });
  await writeFile(path.join(pointDir, "config-snapshot.tar.gz"), "archive", "utf8");

  const prunes = [];
  const { service } = createService(t, stack, {
    deployResult: { ok: false, stdout: "", stderr: "manifest unknown", code: 1 },
    impls: {
      readConfigMountSourceImpl: async () => ({ type: "bind", source: "/config/radarr" }),
      composeDownImpl: async () => ({ ok: true, stdout: "", stderr: "" }),
      restoreConfigSnapshotImpl: async () => ({ ok: true }),
      pruneServiceBackupsImpl: async () => {
        prunes.push(1);
        return { pruned: 1, kept: 1 };
      }
    }
  });

  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr", restoreConfig: true }));

  assert.equal(job.status, JOB_STATUS.FAILED);
  // undoPin puts the newer image back, and the backup taken earlier records that
  // image — which findRollbackPoint skips. Pruning here would leave nothing to
  // retry a transiently failed rollback from.
  assert.deepEqual(prunes, [], "the restore point survives a failed rollback");
  const left = await readdir(path.join(stack.root, ".keelarr-backups", "radarr"));
  assert.ok(left.includes(stamp), `the point is still on disk: ${left.join(", ")}`);
});

test("a rollback whose health check fails keeps the point too", async (t) => {
  const stack = await createStack(t);
  const stamp = "2026-08-03T00-00-00-000Z";
  await writeBackup(stack.root, stamp, {
    imageId: "sha256:previous",
    imageRepoDigest: "linuxserver/radarr@sha256:previous",
    configSnapshot: { file: "config-snapshot.tar.gz", mountType: "bind", mountSource: "/config/radarr" }
  });

  const prunes = [];
  const { service } = createService(t, stack, {
    health: { outcome: HEALTH_OUTCOME.FAILED, reason: "Container is exited.", status: "exited" },
    impls: {
      readConfigMountSourceImpl: async () => ({ type: "bind", source: "/config/radarr" }),
      composeDownImpl: async () => ({ ok: true, stdout: "", stderr: "" }),
      restoreConfigSnapshotImpl: async () => ({ ok: true }),
      pruneServiceBackupsImpl: async () => {
        prunes.push(1);
        return { pruned: 1, kept: 1 };
      }
    }
  });

  const job = await settle(service.startRollback("radarr", { confirmContainerName: "radarr", restoreConfig: true }));

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.deepEqual(prunes, []);
});
