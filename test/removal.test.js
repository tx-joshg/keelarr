import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";

import { RemovalService } from "../src/lib/app-services/removal-service.js";
import { JOB_STATUS, JobRegistry, STEP_STATUS } from "../src/lib/jobs.js";
import { createLogger } from "../src/lib/logger.js";
import { normalizeSettings } from "../src/lib/store.js";

const noop = () => {};
const silentLogger = createLogger({
  level: "error",
  filePath: path.join(tmpdir(), "stackarr-test.log"),
  consoleImpl: { debug: noop, info: noop, warn: noop, error: noop, log: noop }
});

function buildSettings(ids = ["radarr", "prowlarr"]) {
  return normalizeSettings({
    initialized: true,
    stackRoot: "/share/Container/docker",
    configRoot: "/share/Container",
    mediaRoot: "/share/Media",
    downloadsRoot: "/share/Media/Downloads",
    selectedServiceIds: ids
  });
}

function createService(overrides = {}) {
  const calls = [];
  const saved = [];
  const removedPaths = [];

  const service = new RemovalService({
    logger: silentLogger,
    jobs: new JobRegistry({ logger: silentLogger }),
    loadSettingsImpl: async () => overrides.settings || buildSettings(),
    readConfigMountSourceImpl: async () => overrides.configMount ?? { type: "bind", source: "/share/Container/radarr/config" },
    measurePathImpl: async () => "412M",
    backupServiceImpl: async () => {
      calls.push("snapshot");
      return { backupDir: "/backups/radarr/final" };
    },
    composeDownImpl: async () => {
      calls.push("down");
      return { ok: true };
    },
    composeDownRemovingVolumesImpl: async () => {
      calls.push("down-v");
      return { ok: true };
    },
    removeImageImpl: async () => {
      calls.push("rmi");
      return { ok: true, removed: true };
    },
    rmImpl: async (target) => {
      removedPaths.push(target);
      calls.push(`rm:${target}`);
    },
    readUpdateStateImpl: async () => ({ radarr: { status: "current" } }),
    writeUpdateStateImpl: async () => ({}),
    saveSettingsImpl: async (next) => {
      saved.push(next);
      return next;
    },
    appendActivityImpl: async () => {},
    ...overrides.impls
  });

  return { service, calls, saved, removedPaths };
}

async function settle(job) {
  while (job.status === JOB_STATUS.PENDING || job.status === JOB_STATUS.RUNNING) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return job;
}

test("the removal preview never offers to delete shared media or downloads", async () => {
  const { service } = createService();
  const preview = await service.describeRemoval("radarr");

  const targetLabels = Object.values(preview.targets).filter(Boolean).map((t) => t.label).join(" ");
  assert.doesNotMatch(targetLabels, /media|download/i);

  // It says why, rather than silently omitting them.
  assert.deepEqual(preview.preserved.map((p) => p.label), ["Media library", "Downloads"]);
  assert.match(preview.preserved[0].reason, /Shared by every app/);
});

test("the preview reports real paths and sizes so the choice is informed", async () => {
  const { service } = createService();
  const preview = await service.describeRemoval("radarr");

  assert.equal(preview.targets.config.path, "/share/Container/radarr/config");
  assert.equal(preview.targets.config.size, "412M");
  assert.equal(preview.targets.stack.path, "/share/Container/docker/radarr");
  assert.match(preview.targets.backups.path, /\.stackarr-backups\/radarr$/);
});

test("removing an app other apps depend on warns about them", async () => {
  const { service } = createService();
  const preview = await service.describeRemoval("prowlarr");

  assert.equal(preview.warnings.length, 1);
  assert.match(preview.warnings[0].message, /indexers from Prowlarr/);
  assert.match(preview.warnings[0].message, /radarr/);
});

test("keeping everything removes only the container and stack files", async () => {
  const { service, calls, removedPaths } = createService();
  const job = await settle(service.startRemoval("radarr", { confirmContainerName: "radarr" }));

  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);
  assert.deepEqual(job.result.kept, ["config", "image", "backups"]);
  // Config directory must survive.
  assert.ok(!removedPaths.includes("/share/Container/radarr/config"));
  assert.ok(removedPaths.includes("/share/Container/docker/radarr"));
  assert.ok(!calls.includes("rmi"));
});

test("removing everything deletes config, image, stack, and backups", async () => {
  const { service, calls, removedPaths } = createService();
  const job = await settle(service.startRemoval("radarr", {
    confirmContainerName: "radarr",
    removeConfig: true,
    removeImage: true,
    removeBackups: true
  }));

  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);
  assert.deepEqual(job.result.kept, []);
  assert.ok(removedPaths.includes("/share/Container/radarr/config"));
  assert.ok(calls.includes("rmi"));
  assert.match(job.result.summary, /all of its data were removed/);
});

test("a named-volume config is removed via compose down -v, not a filesystem delete", async () => {
  const { service, calls, removedPaths } = createService({
    configMount: { type: "volume", source: "radarr_config" }
  });

  await settle(service.startRemoval("radarr", { confirmContainerName: "radarr", removeConfig: true }));

  assert.ok(calls.includes("down-v"));
  assert.ok(!calls.includes("down"));
  // A volume is not a host path; deleting it as one would do nothing.
  assert.ok(!removedPaths.includes("radarr_config"));
});

test("a bind-mounted config uses a plain compose down and a filesystem delete", async () => {
  const { service, calls } = createService();
  await settle(service.startRemoval("radarr", { confirmContainerName: "radarr", removeConfig: true }));

  assert.ok(calls.includes("down"));
  assert.ok(!calls.includes("down-v"));
});

test("a final snapshot is taken before config is destroyed, unless backups are going too", async () => {
  const keeping = createService();
  await settle(keeping.service.startRemoval("radarr", { confirmContainerName: "radarr", removeConfig: true }));
  assert.ok(keeping.calls.includes("snapshot"), "config deletion should be recoverable");
  assert.equal(keeping.calls.indexOf("snapshot") < keeping.calls.indexOf("down"), true);

  const wiping = createService();
  const job = await settle(wiping.service.startRemoval("radarr", {
    confirmContainerName: "radarr",
    removeConfig: true,
    removeBackups: true
  }));
  assert.ok(!wiping.calls.includes("snapshot"), "a snapshot into backups being deleted is pointless");
  assert.match(job.steps.find((s) => s.name === "snapshot").detail, /pointless/);
});

test("a mismatched confirmation removes nothing", async () => {
  const { service, calls } = createService();
  const job = await settle(service.startRemoval("radarr", { confirmContainerName: "wrong" }));

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.match(job.error.message, /confirmation does not match/);
  assert.deepEqual(calls, []);
});

test("a failure to stop the container aborts before anything is deleted", async () => {
  const { service, removedPaths } = createService({
    impls: { composeDownImpl: async () => ({ ok: false, stdout: "", stderr: "daemon error" }) }
  });
  const job = await settle(service.startRemoval("radarr", {
    confirmContainerName: "radarr",
    removeConfig: true
  }));

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.deepEqual(removedPaths, []);
  assert.equal(job.steps.find((s) => s.name === "config").status, STEP_STATUS.PENDING);
});

test("finalize deselects the service and clears its stored state", async () => {
  const { service, saved } = createService();
  await settle(service.startRemoval("radarr", { confirmContainerName: "radarr" }));

  assert.ok(!saved.at(-1).selectedServiceIds.includes("radarr"));
  assert.equal(saved.at(-1).serviceOverrides.radarr, undefined);
});
