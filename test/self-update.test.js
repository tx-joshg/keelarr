import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { createLogger } from "../src/lib/logger.js";
import {
  SelfUpdateService,
  compareVersions,
  normalizeVersion
} from "../src/lib/app-services/self-update-service.js";

const silentLogger = createLogger({
  level: "error",
  filePath: path.join(os.tmpdir(), `keelarr-self-update-test-${process.pid}.log`),
  consoleImpl: { log() {}, info() {}, warn() {}, error() {}, debug() {} }
});

const CONTROLLER = Object.freeze({
  containerName: "keelarr",
  image: "ghcr.io/tx-joshg/keelarr:0.1.1",
  imageId: "sha256:old",
  projectName: "keelarr",
  serviceName: "keelarr",
  configFiles: ["/share/Container/keelarr/deploy/compose.example.yml"],
  workingDir: "/share/Container/keelarr/deploy",
  mounts: [
    { target: "/var/run/docker.sock", source: "/var/run/docker.sock" },
    { target: "/app/deploy-host", source: "/share/Container/keelarr/deploy" },
    { target: "/app/data", source: "/share/Container/keelarr/data" }
  ]
});

function createService(overrides = {}) {
  const store = { state: overrides.state || {} };
  const service = new SelfUpdateService({
    logger: silentLogger,
    appVersion: overrides.appVersion || "0.1.1",
    jobs: overrides.jobs || null,
    nowImpl: () => Date.parse("2026-08-27T12:00:00.000Z"),
    hostProfileService: {
      loadSettings: async () => ({}),
      readControllerDefinition: async () => {
        if (overrides.controllerThrows) {
          throw new Error("no docker");
        }
        return overrides.controller === undefined ? CONTROLLER : overrides.controller;
      }
    },
    fetchImpl: overrides.fetchImpl || (async () => ({ ok: true, json: async () => ({ tag_name: "v0.1.2" }) })),
    readControllerUpdateStateImpl: async () => store.state,
    writeControllerUpdateStateImpl: async (next) => {
      store.state = next;
      return next;
    }
  });

  return { service, store };
}

test("a newer release is a version comparison, not a string comparison", () => {
  // 0.1.10 sorts below 0.1.9 as text, and getting that backwards tells someone
  // they are current when they are nine releases behind.
  assert.equal(compareVersions("0.1.9", "0.1.10"), -1);
  assert.equal(compareVersions("0.1.10", "0.1.9"), 1);
  assert.equal(compareVersions("0.1.2", "0.1.2"), 0);
  assert.equal(compareVersions("v0.1.1", "0.1.2"), -1);
  assert.equal(compareVersions("0.2.0", "0.1.99"), 1);
  assert.equal(normalizeVersion("v1.2.3"), "1.2.3");
});

test("a host that can update itself reports the newer release as available", async () => {
  const { service } = createService();
  const checked = await service.checkSelfUpdate();

  assert.equal(checked.targetVersion, "0.1.2");
  assert.equal(checked.updateStatus, "ready");
  assert.equal(checked.available, true);
  assert.equal(checked.supported, true);
  assert.equal(checked.reason, null);
  assert.ok(checked.checks.every((check) => check.ok));
});

test("the running version being the newest is reported as current, not as an update", async () => {
  const { service } = createService({ appVersion: "0.1.2" });
  const checked = await service.checkSelfUpdate();

  assert.equal(checked.updateStatus, "current");
  assert.equal(checked.available, false);
});

test("a version that was never checked is unchecked rather than up to date", async () => {
  const { service } = createService();
  const described = await service.describeSelfUpdate();

  assert.equal(described.updateStatus, "unchecked");
  assert.equal(described.targetVersion, null);
  assert.equal(described.available, false);
});

test("a failed check keeps the last answer and says why, instead of reading as up to date", async () => {
  const { service, store } = createService({
    state: { latestVersion: "0.1.2", checkedAt: "2026-08-20T00:00:00.000Z" },
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) })
  });

  const checked = await service.checkSelfUpdate();

  assert.equal(checked.checkError, "GitHub answered 503.");
  // The previous discovery survives, so the dashboard does not silently forget
  // that an update exists because one request failed.
  assert.equal(checked.targetVersion, "0.1.2");
  assert.equal(checked.updateStatus, "ready");
  assert.equal(store.state.latestVersion, "0.1.2");
});

test("a locally built image is refused, naming the image it found", async () => {
  const { service } = createService({
    controller: { ...CONTROLLER, image: "keelarr:local" }
  });

  const described = await service.describeSelfUpdate();
  const check = described.checks.find((entry) => entry.id === "published-image");

  assert.equal(check.ok, false);
  assert.equal(described.supported, false);
  assert.equal(described.available, false);
  assert.match(described.reason, /keelarr:local/);
});

test("each way a host cannot update itself is refused with its own reason", async () => {
  const cases = [
    ["container", { ...CONTROLLER, containerName: null }],
    ["socket", { ...CONTROLLER, mounts: CONTROLLER.mounts.filter((m) => m.target !== "/var/run/docker.sock") }],
    ["compose", { ...CONTROLLER, projectName: null }],
    ["service-label", { ...CONTROLLER, serviceName: null }],
    ["deploy-mount", { ...CONTROLLER, mounts: CONTROLLER.mounts.filter((m) => m.target !== "/app/deploy-host") }],
    ["data-mount", { ...CONTROLLER, mounts: CONTROLLER.mounts.filter((m) => m.target !== "/app/data") }]
  ];

  for (const [id, controller] of cases) {
    const { service } = createService({ controller, state: { latestVersion: "0.1.2", checkedAt: "2026-08-27T00:00:00.000Z" } });
    const described = await service.describeSelfUpdate();
    const check = described.checks.find((entry) => entry.id === id);

    assert.equal(check.ok, false, `${id} should be refused`);
    assert.equal(described.available, false, `${id} should not be available`);
    assert.ok(described.reason, `${id} should carry a reason`);
  }
});

test("an update is refused while another job is running", async () => {
  const { service } = createService({
    state: { latestVersion: "0.1.2", checkedAt: "2026-08-27T00:00:00.000Z" },
    jobs: { list: () => [{ status: "running" }] }
  });

  const described = await service.describeSelfUpdate();

  assert.equal(described.checks.find((entry) => entry.id === "idle").ok, false);
  assert.equal(described.available, false);
  assert.match(described.reason, /half-finished/);
});

test("a controller Keelarr cannot inspect is reported, not thrown", async () => {
  const { service } = createService({ controllerThrows: true });
  const described = await service.describeSelfUpdate();

  assert.equal(described.supported, false);
  assert.equal(described.checks.find((entry) => entry.id === "container").ok, false);
});

test("a scheduled check is due once a day, and immediately when none has run", () => {
  const { service } = createService();
  const now = Date.parse("2026-08-27T12:00:00.000Z");

  assert.equal(service.isCheckDue({}, { now }), true);
  assert.equal(service.isCheckDue({ checkedAt: "2026-08-27T11:00:00.000Z" }, { now }), false);
  assert.equal(service.isCheckDue({ checkedAt: "2026-08-26T11:00:00.000Z" }, { now }), true);
  // An unparseable stamp is not evidence of a recent check.
  assert.equal(service.isCheckDue({ checkedAt: "not a date" }, { now }), true);
});

// --- the update itself -------------------------------------------------------

import { JOB_STATUS, JobRegistry } from "../src/lib/jobs.js";
import { MutationLease } from "../src/lib/mutation-lease.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";

const ENV_FILE = [
  "# Written by Keelarr from its own settings.",
  "KEELARR_PORT=4687",
  "KEELARR_VERSION=0.1.1",
  "KEELARR_DATA_DIR=/share/Container/keelarr/data",
  "HOST_MEDIA_ROOT=/share/Media",
  ""
].join("\n");

async function createUpdater(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "keelarr-self-update-"));
  const envPath = path.join(root, ".env");
  await writeFile(envPath, overrides.envFile ?? ENV_FILE, "utf8");

  const calls = [];
  const detached = [];
  const receipts = [];
  const jobs = new JobRegistry({ logger: silentLogger });
  const lease = overrides.lease || new MutationLease();

  const service = new SelfUpdateService({
    logger: silentLogger,
    jobs,
    lease,
    appVersion: overrides.appVersion || "0.1.1",
    nowImpl: () => Date.parse("2026-08-27T12:00:00.000Z"),
    createOperationId: () => "op123",
    hostProfileService: {
      loadSettings: async () => ({ dockerBin: "docker" }),
      readControllerDefinition: async () => overrides.controller === undefined ? CONTROLLER : overrides.controller
    },
    readControllerUpdateStateImpl: async () => ({ latestVersion: "0.1.2", checkedAt: "2026-08-27T00:00:00.000Z" }),
    writeControllerUpdateStateImpl: async (next) => next,
    readReceiptImpl: async () => overrides.receipt ?? (receipts.length ? receipts[receipts.length - 1] : null),
    writeReceiptImpl: async (receipt) => { receipts.push(receipt); return receipt; },
    pullImageImpl: async () => { calls.push("pull"); return overrides.pullResult || { ok: true }; },
    readImageIdImpl: async () => overrides.targetImageId === undefined ? "sha256:new" : overrides.targetImageId,
    readContainerImageIdImpl: async () => overrides.runningImageId ?? "sha256:old",
    runImageProbeImpl: async () => { calls.push("probe"); return overrides.probeResult || { ok: true }; },
    tagImageImpl: async () => { calls.push("tag"); return { ok: true }; },
    runDetachedContainerImpl: async (settings, spec) => {
      calls.push("run-detached");
      detached.push(spec);
      return overrides.detachedResult || { ok: true };
    },
    readContainerOutcomeImpl: async () => overrides.helperOutcome || { exists: true, status: "exited", exitCode: 0 },
    readContainerLogsImpl: async () => overrides.helperLogs || "",
    removeContainerImpl: async () => ({ ok: true }),
    readFileImpl: async (target) => readFile(target === "/app/deploy-host/.env" ? envPath : target, "utf8"),
    writeFileImpl: async (target, body) => {
      calls.push("write-env");
      return writeFile(target === "/app/deploy-host/.env" ? envPath : path.join(root, path.basename(target)), body, "utf8");
    },
    copyFileImpl: async () => {},
    statImpl: async () => ({ mode: 0o644 }),
    chmodImpl: async () => {},
    ackPathImpl: (id) => path.join(root, `ack-${id}`),
    appendActivityImpl: async () => {}
  });

  return { service, jobs, lease, calls, detached, receipts, envPath, root };
}

test("the updater is given the deploy directory at the same path on both sides", async (t) => {
  // compose.example.yml binds ./ and ../data, which the daemon resolves on the
  // host. Mounted anywhere else, the recreated controller would bind paths that
  // do not exist and Docker would create them empty — Keelarr would come back
  // with no settings at all.
  const { service, detached } = await createUpdater(t);
  service.startSelfUpdate();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const spec = detached[0];
  const deployMount = spec.mounts.find((mount) => mount.target === "/share/Container/keelarr/deploy");

  assert.ok(deployMount, "the deploy directory must be mounted at its own host path");
  assert.equal(deployMount.source, deployMount.target);
  assert.equal(spec.mounts.find((m) => m.target === "/var/run/docker.sock").source, "/var/run/docker.sock");
  assert.equal(spec.mounts.find((m) => m.target === "/app/data").source, "/share/Container/keelarr/data");
  // The current image, proven on this host — not the one being installed.
  assert.equal(spec.image, "sha256:old");
  assert.equal(spec.name, "keelarr-self-update-op123");
  assert.equal(spec.network, "none");
});

test("the updater replays the whole compose identity, not just one file", async (t) => {
  const { service, detached } = await createUpdater(t, {
    controller: {
      ...CONTROLLER,
      configFiles: ["/deploy/compose.example.yml", "/deploy/compose.override.yml"],
      projectName: "keelarr", serviceName: "keelarr", workingDir: "/deploy"
    }
  });
  service.startSelfUpdate();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const env = detached[0].environment;

  // Every file, in order: Compose merges them left to right, so dropping one
  // silently changes the model it recreates from.
  assert.equal(env.SU_FILE_ARGS, "-f /deploy/compose.example.yml -f /deploy/compose.override.yml");
  assert.equal(env.SU_PROJECT, "keelarr");
  assert.equal(env.SU_SERVICE, "keelarr");
  assert.equal(env.SU_PROJECT_DIR, "/deploy");
  assert.equal(env.SU_TARGET_IMAGE_ID, "sha256:new");
});

test("the job is handed off rather than finished, so nothing records a success early", async (t) => {
  // start() marks a job succeeded the moment its handler returns, and the
  // updater sleeps before stopping anything — so a handler that returned would
  // persist a success before the update had begun.
  const { service, jobs } = await createUpdater(t);
  const job = service.startSelfUpdate();
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(job.status, JOB_STATUS.HANDED_OFF);
  assert.equal(job.subject.operationId, "op123");

  await jobs.hydrate();
  assert.equal(job.status, JOB_STATUS.HANDED_OFF, "a restart must not rewrite a handed-off job");
});

test("pinning the version leaves every other line of the env file alone", async (t) => {
  const { service, envPath } = await createUpdater(t);
  service.startSelfUpdate();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const written = await readFile(envPath, "utf8");

  assert.match(written, /^KEELARR_VERSION=0\.1\.2$/m);
  assert.match(written, /^HOST_MEDIA_ROOT=\/share\/Media$/m);
  assert.match(written, /^KEELARR_PORT=4687$/m);
  assert.match(written, /^# Written by Keelarr/m);
});

test("a new image that does not run here fails before anything is changed", async (t) => {
  const { service, calls, envPath } = await createUpdater(t, { probeResult: { ok: false, stderr: "no matching manifest" } });
  service.startSelfUpdate();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(calls, ["pull", "probe"]);
  assert.equal(await readFile(envPath, "utf8"), ENV_FILE, "the env file must be untouched");
});

test("an updater that cannot start puts the env file back", async (t) => {
  const { service, envPath, lease } = await createUpdater(t, { detachedResult: { ok: false, stderr: "no such image" } });
  service.startSelfUpdate();
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(await readFile(envPath, "utf8"), ENV_FILE);
  assert.equal(lease.isHeld(), false, "the lease must not stay held after a failed handoff");
});

test("nothing else may change the stack while an update is in flight", async (t) => {
  const lease = new MutationLease();
  lease.acquire({ reason: "A Keelarr update", operationId: "op123" });

  assert.throws(() => lease.assertAvailable("A cutover"), /cannot start while a keelarr update is running/i);
  lease.release("op123");
  assert.doesNotThrow(() => lease.assertAvailable("A cutover"));
});

test("a lease outlives neither its term nor a release from a superseded attempt", () => {
  let clock = 0;
  const lease = new MutationLease({ nowImpl: () => clock, ttlMs: 1000 });
  lease.acquire({ reason: "A Keelarr update", operationId: "first" });

  assert.equal(lease.release("second"), false, "a different operation must not free it");
  assert.equal(lease.isHeld(), true);

  clock = 1001;
  assert.equal(lease.isHeld(), false, "a crashed update must not wedge the stack for ever");
});

test("reconciliation reports success from the running image, not from the helper", async (t) => {
  const { service, receipts } = await createUpdater(t, {
    runningImageId: "sha256:new",
    receipt: {
      schema: 1, operationId: "op123", status: "handed-off", containerName: "keelarr",
      helperContainer: "keelarr-self-update-op123", previousImageId: "sha256:old", previousVersion: "0.1.1",
      targetImageId: "sha256:new", targetVersion: "0.1.2", acknowledged: false
    }
  });

  const result = await service.reconcile();

  assert.equal(result.status, "succeeded");
  assert.match(receipts[receipts.length - 1].detail, /Updated to 0\.1\.2/);
});

test("reconciliation reports a rollback when the previous image is what came back", async (t) => {
  const { service } = await createUpdater(t, {
    runningImageId: "sha256:old",
    helperOutcome: { exists: true, status: "exited", exitCode: 10 },
    receipt: {
      schema: 1, operationId: "op123", status: "handed-off", containerName: "keelarr",
      helperContainer: "keelarr-self-update-op123", previousImageId: "sha256:old", previousVersion: "0.1.1",
      targetImageId: "sha256:new", targetVersion: "0.1.2", acknowledged: false
    }
  });

  const result = await service.reconcile();

  assert.equal(result.status, "rolled-back");
  assert.match(result.detail, /put back on 0\.1\.1/);
});

test("reconciliation waits rather than guessing while the updater is still deciding", async (t) => {
  const { service } = await createUpdater(t, {
    runningImageId: "sha256:other",
    helperOutcome: { exists: true, status: "running", exitCode: null },
    receipt: {
      schema: 1, operationId: "op123", status: "handed-off", containerName: "keelarr",
      helperContainer: "keelarr-self-update-op123", previousImageId: "sha256:old",
      targetImageId: "sha256:new", targetVersion: "0.1.2", acknowledged: false
    }
  });

  const result = await service.reconcile();

  assert.equal(result.status, "handed-off");
});

test("an ordinary start with no update behind it does no Docker work at all", async (t) => {
  const { service, calls } = await createUpdater(t, { receipt: null });

  assert.equal(await service.reconcile(), null);
  assert.deepEqual(calls, []);
});

test("an outcome that has been seen is not re-derived on every later start", async (t) => {
  const { service, calls } = await createUpdater(t, {
    receipt: { schema: 1, operationId: "op123", status: "succeeded", acknowledged: true }
  });

  assert.equal(await service.reconcile(), null);
  assert.deepEqual(calls, [], "a settled receipt must not reinterpret a later manual version change");
});

test("the recovery command names a directory and the configured docker binary", async (t) => {
  // Printed for someone to run on the host, where Keelarr's own `docker` may
  // not be on the path — this NAS is exactly that case. A safety net that does
  // not run is worse than none.
  const { service } = await createUpdater(t);
  const command = service.buildRecoveryCommand(
    { ...CONTROLLER, workingDir: "/deploy", configFiles: ["/deploy/a.yml", "/deploy/b.yml"] },
    { dockerBin: "/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker" }
  );

  assert.match(command, /^cd \/deploy && /);
  assert.match(command, /KEELARR_VERSION=0\.1\.1 /);
  assert.match(command, /container-station\/bin\/docker compose -p keelarr/);
  assert.match(command, /-f \/deploy\/a\.yml -f \/deploy\/b\.yml/);
  assert.match(command, /--env-file \/deploy\/\.env up -d keelarr$/);
  // No binary configured is still a usable command, just PATH-dependent.
  assert.match(service.buildRecoveryCommand(CONTROLLER, {}), / docker compose /);
});
