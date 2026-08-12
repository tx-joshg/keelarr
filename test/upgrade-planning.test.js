import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";

import { ManagedStackService } from "../src/lib/app-services/managed-stack-service.js";
import { JobRegistry, JOB_STATUS } from "../src/lib/jobs.js";
import { createLogger } from "../src/lib/logger.js";

const noop = () => {};
const silentLogger = createLogger({
  level: "error",
  filePath: path.join(tmpdir(), "stackarr-upgrade-planning-test.log"),
  consoleImpl: { debug: noop, info: noop, warn: noop, error: noop, log: noop }
});

const SERVICES = [
  { id: "sonarr", name: "Sonarr", containerName: "sonarr" },
  { id: "radarr", name: "Radarr", containerName: "radarr" },
  { id: "trailarr", name: "Trailarr", containerName: "trailarr" },
  { id: "lidarr", name: "Lidarr", containerName: "lidarr" }
];

/** The state the nightly check leaves behind, as seen on the live NAS. */
const UPDATE_STATE = {
  sonarr: { status: "ready" },
  radarr: { status: "current" },
  trailarr: { status: "unknown" }
  // lidarr deliberately absent: never checked.
};

function createService(overrides = {}) {
  const settings = {
    selectedServiceIds: SERVICES.map((service) => service.id),
    services: Object.fromEntries(SERVICES.map((service) => [service.id, service]))
  };

  return new ManagedStackService({
    logger: silentLogger,
    jobs: new JobRegistry({ logger: silentLogger }),
    loadSettingsImpl: async () => settings,
    readUpdateStateImpl: async () => UPDATE_STATE,
    writeUpdateStateImpl: async () => ({}),
    appendActivityImpl: async () => {},
    ...overrides
  });
}

test("only services known to need an update are planned", () => {
  const plan = createService().planUpgradeAll(SERVICES, UPDATE_STATE);

  assert.deepEqual(plan.upgradable.map((service) => service.id), ["sonarr"]);
  assert.deepEqual(plan.current.map((service) => service.id), ["radarr"]);
  // Unknown and never-checked are the same situation from the operator's side:
  // Stackarr cannot say, so it does not act.
  assert.deepEqual(plan.unchecked.map((service) => service.id), ["trailarr", "lidarr"]);
});

test("an unreadable version is not an invitation to upgrade", () => {
  // Trailarr was only ever in that run because its status was unknown, and the
  // pull it triggered is what failed.
  const plan = createService().planUpgradeAll(SERVICES, UPDATE_STATE);

  assert.equal(plan.upgradable.some((service) => service.id === "trailarr"), false);
});

test("force upgrades everything, including what looks current", () => {
  const plan = createService().planUpgradeAll(SERVICES, UPDATE_STATE, { force: true });

  assert.deepEqual(plan.upgradable.map((service) => service.id), SERVICES.map((service) => service.id));
  assert.deepEqual(plan.unchecked, []);
});

test("a service that is not installed is left alone rather than treated as unknown", () => {
  const plan = createService().planUpgradeAll(SERVICES, { ...UPDATE_STATE, lidarr: { status: "not-deployed" } });

  assert.equal(plan.unchecked.map((service) => service.id).includes("lidarr"), false);
  assert.equal(plan.current.map((service) => service.id).includes("lidarr"), true);
});

test("the job's steps are the work, not a roll-call of the stack", async () => {
  const upgraded = [];
  const service = createService({
    upgradeServiceImpl: async (_settings, target) => {
      upgraded.push(target.id);
      return { ok: true, stdout: "", stderr: "" };
    },
    readConfigMountSourceImpl: async () => null,
    verifyServiceHealthImpl: async () => ({ outcome: "verified", reason: "healthy" })
  });
  service.serviceIsDeployed = async () => true;
  service.clearRollbackPin = async () => {};
  service.recordFreshImageState = async () => {};

  const started = await service.startUpgradeAll({}, {}).create();

  assert.deepEqual(started.steps.map((step) => step.name), ["sonarr"]);
  assert.equal(started.steps.length, 1, "four services selected, one actually needs upgrading");
});

test("nothing to upgrade produces an answer rather than an empty progress panel", async () => {
  const service = createService({
    readUpdateStateImpl: async () => ({
      sonarr: { status: "current" },
      radarr: { status: "current" },
      trailarr: { status: "current" },
      lidarr: { status: "current" }
    })
  });

  const started = await service.startUpgradeAll({}, {}).create();

  assert.equal(started.job, null);
  assert.equal(started.upgraded, 0);
  assert.match(started.message, /already up to date/i);
});

test("when everything checkable is current, the unreadable ones are named", async () => {
  const service = createService({
    readUpdateStateImpl: async () => ({
      sonarr: { status: "current" },
      radarr: { status: "current" },
      trailarr: { status: "unknown" },
      lidarr: { status: "current" }
    })
  });

  const started = await service.startUpgradeAll({}, {}).create();

  assert.equal(started.job, null);
  assert.deepEqual(started.unchecked, ["trailarr"]);
  assert.match(started.message, /Trailarr/);
});

test("an upgrade reports the phase it is in, not just that it is running", async () => {
  const phases = [];
  const service = createService({
    upgradeServiceImpl: async () => ({ ok: true, stdout: "", stderr: "" }),
    verifyServiceHealthImpl: async () => ({ outcome: "verified", reason: "healthy" })
  });
  service.serviceIsDeployed = async () => true;
  service.clearRollbackPin = async () => {};
  service.recordFreshImageState = async () => {};

  await service.upgradeOne(
    { services: {} },
    SERVICES[0],
    silentLogger,
    { onPhase: (label) => phases.push(label) }
  );

  assert.deepEqual(phases, [
    "Backing up Sonarr",
    "Downloading the new Sonarr image",
    "Waiting for Sonarr to come back"
  ]);
});

test("a failed service inside upgrade-all fails the job without stranding the rest", async () => {
  const service = createService({
    readUpdateStateImpl: async () => ({ sonarr: { status: "ready" }, radarr: { status: "ready" } }),
    upgradeServiceImpl: async (_settings, target) => (
      target.id === "sonarr"
        ? { ok: false, stdout: "", stderr: "Image pull stalled." }
        : { ok: true, stdout: "", stderr: "" }
    ),
    verifyServiceHealthImpl: async () => ({ outcome: "verified", reason: "healthy" })
  });
  service.serviceIsDeployed = async () => true;
  service.clearRollbackPin = async () => {};
  service.recordFreshImageState = async () => {};

  const job = await service.startUpgradeAll({}, {}).create();

  while (job.status === JOB_STATUS.PENDING || job.status === JOB_STATUS.RUNNING) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(job.status, JOB_STATUS.FAILED);
  // Radarr still went through — one bad service must not strand the others.
  assert.equal(job.steps.find((step) => step.name === "radarr").status, "succeeded");
  assert.equal(job.steps.find((step) => step.name === "sonarr").status, "failed");
  assert.equal(job.result.upgraded, 1);
  assert.equal(job.result.failed, 1);
});

// --- when a check is allowed to happen ---

test("a stack that has never been checked is due", () => {
  const service = createService();

  assert.equal(service.isUpdateCheckDue({}), true);
  assert.equal(service.isUpdateCheckDue({ sonarr: {} }), true);
});

test("a check yesterday is due, a check an hour ago is not", () => {
  const service = createService();
  const now = Date.parse("2026-08-12T12:00:00.000Z");
  const state = (checkedAt) => ({ sonarr: { status: "current", checkedAt } });

  assert.equal(service.isUpdateCheckDue(state("2026-08-11T11:00:00.000Z"), { now }), true);
  assert.equal(service.isUpdateCheckDue(state("2026-08-12T11:00:00.000Z"), { now }), false);
});

test("the newest check counts, so one failed service does not force a re-check", () => {
  const service = createService();
  const now = Date.parse("2026-08-12T12:00:00.000Z");

  assert.equal(
    service.isUpdateCheckDue(
      {
        sonarr: { checkedAt: "2026-08-01T00:00:00.000Z" },
        radarr: { checkedAt: "2026-08-12T11:30:00.000Z" }
      },
      { now }
    ),
    false
  );
});

test("an unreadable timestamp is treated as no check at all", () => {
  const service = createService();

  assert.equal(service.isUpdateCheckDue({ sonarr: { checkedAt: "sometime last week" } }), true);
});

test("the schedule runs a check when one is overdue, and stops cleanly", async () => {
  const checks = [];
  const timers = [];
  const service = createService({ readUpdateStateImpl: async () => ({}) });
  service.checkAllUpdates = async (context) => {
    checks.push(context.trigger);
    return { ok: true };
  };

  const stop = service.startUpdateSchedule({
    startupDelayMs: 0,
    setTimeoutImpl: (fn) => {
      timers.push(fn);
      return { unref() {} };
    },
    setIntervalImpl: () => ({ unref() {} })
  });

  await timers[0]();

  assert.deepEqual(checks, ["startup"]);
  assert.equal(typeof stop, "function");
});

test("the schedule leaves a recently checked stack alone at startup", async () => {
  const checks = [];
  const timers = [];
  const service = createService({
    readUpdateStateImpl: async () => ({ sonarr: { checkedAt: new Date().toISOString() } })
  });
  service.checkAllUpdates = async () => {
    checks.push("ran");
  };

  service.startUpdateSchedule({
    startupDelayMs: 0,
    setTimeoutImpl: (fn) => {
      timers.push(fn);
      return { unref() {} };
    },
    setIntervalImpl: () => ({ unref() {} })
  });

  await timers[0]();

  assert.deepEqual(checks, []);
});

test("a scheduled check stands aside while a job is running", async () => {
  const checks = [];
  const service = createService({ readUpdateStateImpl: async () => ({}) });
  service.checkAllUpdates = async () => {
    checks.push("ran");
  };
  // Two pulls of the same image at once, and the upgrade is the one that
  // matters.
  service.jobs = { list: () => [{ status: "running" }] };

  let scheduled = null;
  service.startUpdateSchedule({
    startupDelayMs: 0,
    setTimeoutImpl: () => ({ unref() {} }),
    setIntervalImpl: (fn) => {
      scheduled = fn;
      return { unref() {} };
    }
  });

  await scheduled();

  assert.deepEqual(checks, []);
});

test("a failing check does not take the controller down", async () => {
  const service = createService({ readUpdateStateImpl: async () => ({}) });
  service.checkAllUpdates = async () => {
    throw new Error("registry unreachable");
  };

  let scheduled = null;
  service.startUpdateSchedule({
    startupDelayMs: 0,
    setTimeoutImpl: () => ({ unref() {} }),
    setIntervalImpl: (fn) => {
      scheduled = fn;
      return { unref() {} };
    }
  });

  await scheduled();
});
