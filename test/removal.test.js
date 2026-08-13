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
  filePath: path.join(tmpdir(), "keelarr-test.log"),
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
    readConfigMountSourceImpl: async () => ("configMount" in overrides ? overrides.configMount : { type: "bind", source: "/share/Container/radarr/config" }),
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
  assert.match(preview.targets.backups.path, /\.keelarr-backups\/radarr$/);
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

test("finalize deselects the service and keeps a record of how to bring it back", async () => {
  const { service, saved } = createService();
  await settle(service.startRemoval("radarr", { confirmContainerName: "radarr" }));
  const override = saved.at(-1).serviceOverrides.radarr;

  assert.ok(!saved.at(-1).selectedServiceIds.includes("radarr"));
  // Config was kept, so the identity is kept too. Dropping it turns an
  // imported service into a catalog one on reinstall, pointing at a config
  // path that has never existed — the app returns empty.
  assert.ok(override, "a service whose config was kept must remember what it was");
  assert.equal(override.containerName, "radarr");
  assert.ok(override.restoreFrom, "the archived stack location must be recorded");
});

test("a kept named volume is named in the summary, not reported as absent", async () => {
  // The mount is resolved during preflight and reused. Looking it up again
  // after the container is removed finds nothing — for a named volume there is
  // no conventional path to fall back to — and a 112MB database that is very
  // much still there gets reported as "no configuration exists on disk".
  const { service } = createService({ configMount: { type: "volume", source: "radarr_config" } });
  const job = await settle(service.startRemoval("radarr", { confirmContainerName: "radarr" }));

  const step = job.steps.find((s) => s.name === "config");
  assert.match(step.detail, /radarr_config volume/);
  assert.deepEqual(job.result.kept, ["config", "image", "backups"]);
});

test("a kept bind-mounted config names its path", async () => {
  const { service } = createService();
  const job = await settle(service.startRemoval("radarr", { confirmContainerName: "radarr" }));

  assert.match(job.steps.find((s) => s.name === "config").detail, /\/share\/Container\/radarr\/config/);
});

test("finalize clears stored state entirely when the config is deleted too", async () => {
  const { service, saved } = createService();
  await settle(service.startRemoval("radarr", { confirmContainerName: "radarr", removeConfig: true }));

  assert.ok(!saved.at(-1).selectedServiceIds.includes("radarr"));
  // Nothing left to come back to, so keeping a restore record would promise
  // something that cannot be delivered.
  assert.equal(saved.at(-1).serviceOverrides.radarr, undefined);
});

test("a removal still succeeds when the stack files cannot be archived", async () => {
  const { service } = createService({
    impls: {
      backupServiceImpl: async () => {
        throw new Error("backup volume is full");
      }
    }
  });
  const job = await settle(service.startRemoval("radarr", { confirmContainerName: "radarr" }));

  // The config is being kept, so nothing is at risk. Losing the archive costs
  // only the ability to reinstall as the same service, and the step says so.
  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);
  assert.match(job.steps.find((s) => s.name === "snapshot").detail, /start this app fresh/);
});

test("a removal that destroys config aborts when the snapshot fails", async () => {
  const { service } = createService({
    impls: {
      backupServiceImpl: async () => {
        throw new Error("backup volume is full");
      }
    }
  });
  const job = await settle(
    service.startRemoval("radarr", { confirmContainerName: "radarr", removeConfig: true })
  );

  // Here the snapshot is the difference between recoverable and gone.
  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.match(job.error.message, /backup volume is full/);
});

test("removeImage treats 'no such image' and 'in use' as non-failures", async () => {
  // The job must surface a readable reason, not a raw daemon string, whether
  // the image was never pulled or is still in use elsewhere.
  const cases = [
    { out: "Error response from daemon: No such image: x:develop", expect: /was not present/ },
    { out: "conflict: unable to delete, image is being used by running container", expect: /another container still uses it/ }
  ];

  for (const c of cases) {
    const service = new RemovalService({
      logger: silentLogger,
      jobs: new JobRegistry({ logger: silentLogger }),
      loadSettingsImpl: async () => buildSettings(),
      readConfigMountSourceImpl: async () => null,
      composeDownImpl: async () => ({ ok: true }),
      removeImageImpl: async () => ({ ok: true, removed: false, reason: c.out.includes("No such") ? "Image was not present on this host." : "Image kept: another container still uses it." }),
      rmImpl: async () => {},
      readUpdateStateImpl: async () => ({}),
      writeUpdateStateImpl: async () => ({}),
      saveSettingsImpl: async (n) => n,
      appendActivityImpl: async () => {}
    });

    const job = await settle(service.startRemoval("radarr", { confirmContainerName: "radarr", removeImage: true }));
    const step = job.steps.find((s) => s.name === "image");
    assert.match(step.detail, c.expect);
    assert.equal(job.status, JOB_STATUS.SUCCEEDED);
  }

});

test("the config option is still offered when the container is gone", async () => {
  // A failed install or a stopped service has no container to inspect. Hiding
  // the option there silently preserved data the operator asked to delete.
  const { service } = createService({
    configMount: null,
    impls: { pathExistsImpl: async () => true }
  });

  const preview = await service.describeRemoval("radarr");

  assert.equal(preview.targets.config.absent, undefined);
  assert.equal(preview.targets.config.inferred, true);
  assert.equal(preview.targets.config.path, "/share/Container/radarr/config");
});

test("with no container and no config on disk, the dialog is told there is nothing to delete", async () => {
  const { service } = createService({
    configMount: null,
    impls: { pathExistsImpl: async () => false }
  });

  const preview = await service.describeRemoval("radarr");

  assert.equal(preview.targets.config.absent, true);
});

test("removal deletes the inferred config path when the container is gone", async () => {
  const { service, removedPaths } = createService({
    configMount: null,
    impls: { pathExistsImpl: async () => true }
  });

  const job = await settle(service.startRemoval("radarr", {
    confirmContainerName: "radarr",
    removeConfig: true
  }));

  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);
  assert.ok(removedPaths.includes("/share/Container/radarr/config"));
  assert.deepEqual(job.result.kept, ["image", "backups"]);
});

test("it does not claim to have kept configuration that never existed", async () => {
  const { service } = createService({
    configMount: null,
    impls: { pathExistsImpl: async () => false }
  });

  const job = await settle(service.startRemoval("radarr", { confirmContainerName: "radarr" }));

  assert.ok(!job.result.kept.includes("config"));
  assert.match(job.steps.find((s) => s.name === "config").detail, /No configuration exists/);
});

test("removing a service warns about what will still point at it", async () => {
  // Removal deletes the container, its files and its backups, but it cannot
  // reach into Prowlarr and delete the proxy Prowlarr was told about. Saying so
  // before the choice is the difference between a decision and a surprise.
  const { service } = createService({ settings: buildSettings(["prowlarr", "flaresolverr"]) });
  const preview = await service.describeRemoval("flaresolverr");

  assert.deepEqual(preview.stillReferencedBy.apps.map((entry) => entry.serviceId), ["prowlarr"]);
  assert.match(preview.stillReferencedBy.note, /indexer proxy/);
  assert.match(preview.stillReferencedBy.note, /only you can remove it/);
});

test("an app nothing else references says nothing about leftovers", async () => {
  const { service } = createService({ settings: buildSettings(["tautulli"]) });
  const preview = await service.describeRemoval("tautulli");

  assert.equal(preview.stillReferencedBy, null);
});

test("only apps actually in the stack are named as holding a reference", async () => {
  // Bazarr references Radarr, but if Bazarr is not installed it must not be
  // listed — a warning about an app you do not run is noise.
  const { service } = createService({ settings: buildSettings(["prowlarr", "radarr"]) });
  const preview = await service.describeRemoval("radarr");

  assert.deepEqual(preview.stillReferencedBy.apps.map((entry) => entry.serviceId), ["prowlarr"]);
});
