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

test("a successful upgrade clears a stale update status", async (t) => {
  const stack = await createStack(t);
  const stored = { radarr: { status: "rolled-back", checkedAt: "2026-08-05T00:00:00.000Z" } };

  const service = new ManagedStackService({
    logger: silentLogger,
    loadSettingsImpl: async () => stack.settings,
    upgradeServiceImpl: async () => ({ ok: true, stdout: "", stderr: "" }),
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

async function settleJobById(service, jobId) {
  for (let i = 0; i < 500; i += 1) {
    const job = service.jobs.get(jobId);
    if (job.status === JOB_STATUS.SUCCEEDED || job.status === JOB_STATUS.FAILED) {
      return job;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("job never settled");
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

  const updateState = {};
  const pulled = [];
  const service = new ManagedStackService({
    logger: silentLogger,
    jobs: new JobRegistry({ logger: silentLogger }),
    loadSettingsImpl: async () => stack.settings,
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
    upgradeServiceImpl: async (_s, svc) => {
      attempted.push(svc.id);
      return svc.id === "sonarr"
        ? { ok: false, stdout: "", stderr: "manifest unknown" }
        : { ok: true, stdout: "", stderr: "" };
    },
    verifyServiceHealthImpl: async () => ({ outcome: HEALTH_OUTCOME.VERIFIED, reason: "healthy" }),
    readUpdateStateImpl: async () => ({}),
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
    upgradeServiceImpl: async () => ({ ok: true, stdout: "", stderr: "" }),
    verifyServiceHealthImpl: async () => ({ outcome: HEALTH_OUTCOME.FAILED, reason: "Container is exited." }),
    readUpdateStateImpl: async () => ({}),
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
    upgradeServiceImpl: async (_s, svc) => {
      attempted.push(svc.id);
      return { ok: true, stdout: "", stderr: "" };
    },
    verifyServiceHealthImpl: async () => ({ outcome: HEALTH_OUTCOME.VERIFIED, reason: "healthy" }),
    readUpdateStateImpl: async () => ({}),
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
  assert.match(job.steps.find((s) => s.name === "sonarr").detail, /Already current/);
});

test("Upgrade All with force re-pulls everything regardless of status", async (t) => {
  const stack = await createStackWith(t, ["radarr", "sonarr"]);
  const attempted = [];
  const service = new ManagedStackService({
    logger: silentLogger,
    jobs: new JobRegistry({ logger: silentLogger }),
    loadSettingsImpl: async () => stack.settings,
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
    upgradeServiceImpl: async () => ({ ok: true, stdout: "", stderr: "" }),
    readUpdateStateImpl: async () => ({ radarr: { status: "current" } }),
    writeUpdateStateImpl: async () => ({}),
    appendActivityImpl: async () => {}
  });

  const job = await settleJobById(service, (await service.startUpgradeAll().create()).id);

  assert.match(job.result.summary, /Nothing to upgrade/);
});

/* --- a freshly deployed service must not report "Unknown" --- */

function createDeployService(t, stack, updateState, deployed) {
  return new ManagedStackService({
    logger: silentLogger,
    loadSettingsImpl: async () => stack.settings,
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
