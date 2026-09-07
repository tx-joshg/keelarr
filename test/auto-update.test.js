import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";

import { AUTO_UPDATE_TOLERANCE_MS, decideAutoUpdate, describeNextRun } from "../src/lib/auto-update-window.js";
import { MutationLease } from "../src/lib/mutation-lease.js";
import { ManagedStackService } from "../src/lib/app-services/managed-stack-service.js";
import { JOB_STATUS, JobRegistry, STEP_STATUS } from "../src/lib/jobs.js";
import { HEALTH_OUTCOME } from "../src/lib/health.js";
import { createLogger } from "../src/lib/logger.js";

const noop = () => {};
const silentLogger = createLogger({
  level: "error",
  filePath: path.join(tmpdir(), "keelarr-auto-update-test.log"),
  consoleImpl: { debug: noop, info: noop, warn: noop, error: noop, log: noop }
});

// Chicago, 03:00, daylight time: the window opens at 08:00Z.
const SETTINGS = { autoUpdateEnabled: true, autoUpdateTime: "03:00", tz: "America/Chicago" };
const at = (iso) => Date.parse(iso);

// --- the decision, pure -------------------------------------------------------

test("the window opens at the configured minute in the configured zone, not in UTC", () => {
  assert.deepEqual(
    decideAutoUpdate({ now: at("2026-09-07T08:00:00Z"), settings: SETTINGS, state: {} }),
    { run: true, windowKey: "2026-09-07", tzFallback: false }
  );
  // 03:00 UTC is 22:00 the evening before in Chicago.
  assert.equal(decideAutoUpdate({ now: at("2026-09-07T03:00:00Z"), settings: SETTINGS, state: {} }).reason, "outside-window");
});

test("the window fires once per day", () => {
  const state = { lastWindowKey: "2026-09-07" };
  assert.equal(decideAutoUpdate({ now: at("2026-09-07T08:10:00Z"), settings: SETTINGS, state }).reason, "already-ran");
  assert.equal(decideAutoUpdate({ now: at("2026-09-08T08:00:00Z"), settings: SETTINGS, state }).run, true);
});

test("a window missed entirely waits for the next one", () => {
  // 04:00 local, an hour after 03:00 and past the half-hour tolerance. No
  // catch-up: "unattended at a time I chose" must not become "whenever".
  const decision = decideAutoUpdate({ now: at("2026-09-07T09:00:00Z"), settings: SETTINGS, state: {} });
  assert.equal(decision.run, false);
  assert.equal(decision.reason, "outside-window");
  assert.equal(AUTO_UPDATE_TOLERANCE_MS, 30 * 60 * 1000);
});

test("a window that opens before midnight can close after it", () => {
  const settings = { ...SETTINGS, autoUpdateTime: "23:50" };
  // 00:10 local on the 8th is twenty minutes into the window that opened on the 7th.
  const decision = decideAutoUpdate({ now: at("2026-09-08T05:10:00Z"), settings, state: {} });
  assert.equal(decision.run, true);
  assert.equal(decision.windowKey, "2026-09-07");
});

test("the window is inert while auto-update is off, or the time is not a time", () => {
  assert.equal(decideAutoUpdate({ now: at("2026-09-07T08:00:00Z"), settings: { ...SETTINGS, autoUpdateEnabled: false }, state: {} }).reason, "disabled");
  assert.equal(decideAutoUpdate({ now: at("2026-09-07T08:00:00Z"), settings: { ...SETTINGS, autoUpdateTime: "25:00" }, state: {} }).reason, "invalid-time");
});

test("an unknown zone still opens the window, in UTC, and says so", () => {
  const settings = { ...SETTINGS, tz: "Mars/Olympus", autoUpdateTime: "08:00" };
  const decision = decideAutoUpdate({ now: at("2026-09-07T08:00:00Z"), settings, state: {} });
  assert.equal(decision.run, true);
  assert.equal(decision.tzFallback, true);
});

test("the next run is the next occurrence of the time, today or tomorrow", () => {
  // 02:00 local: an hour away.
  assert.equal(describeNextRun({ now: at("2026-09-07T07:00:00Z"), settings: SETTINGS }), "2026-09-07T08:00:00.000Z");
  // 04:00 local: tomorrow's.
  assert.equal(describeNextRun({ now: at("2026-09-07T09:00:00Z"), settings: SETTINGS }), "2026-09-08T08:00:00.000Z");
  assert.equal(describeNextRun({ now: at("2026-09-07T09:00:00Z"), settings: { ...SETTINGS, autoUpdateTime: "nope" } }), null);
});

test("an open window that has not run yet is the next run, not tomorrow's", () => {
  // At 03:10 with the window unclaimed — the tick stood aside behind a job —
  // the scheduler may start on the next minute.
  assert.equal(describeNextRun({ now: at("2026-09-07T08:10:00Z"), settings: SETTINGS, state: {} }), "2026-09-07T08:00:00.000Z");
  assert.equal(describeNextRun({ now: at("2026-09-07T08:10:00Z"), settings: SETTINGS, state: { lastWindowKey: "2026-09-07" } }), "2026-09-08T08:00:00.000Z");
  // Exactly on the minute, already run: tomorrow, not "now".
  assert.equal(describeNextRun({ now: at("2026-09-07T08:00:00Z"), settings: SETTINGS, state: { lastWindowKey: "2026-09-07" } }), "2026-09-08T08:00:00.000Z");
});

// --- the tick and the job ------------------------------------------------------

function createService(overrides = {}) {
  const calls = [];
  const state = { auto: overrides.autoState || {}, updates: overrides.updateState || {} };
  const services = overrides.services || {
    radarr: { id: "radarr", name: "Radarr", containerName: "radarr", autoUpdate: true },
    sonarr: { id: "sonarr", name: "Sonarr", containerName: "sonarr", autoUpdate: false }
  };
  const settings = {
    ...SETTINGS,
    autoRevert: overrides.autoRevert === true,
    tz: "America/Chicago",
    selectedServiceIds: Object.keys(services),
    services
  };

  const service = new ManagedStackService({
    logger: silentLogger,
    jobs: new JobRegistry({ logger: silentLogger }),
    loadSettingsImpl: async () => settings,
    readAutoUpdateStateImpl: async () => state.auto,
    writeAutoUpdateStateImpl: async (next) => {
      calls.push(`auto-state:${next.lastWindowKey || "-"}`);
      state.auto = next;
      return next;
    },
    readUpdateStateImpl: async () => state.updates,
    writeUpdateStateImpl: async (next) => Object.assign(state.updates, next),
    checkForUpdatesImpl: async (_s, svc) => {
      calls.push(`check:${svc.id}`);
      return { ok: true, updateStatus: overrides.checkStatus?.[svc.id] || "ready", stdout: "", stderr: "" };
    },
    readContainerImageIdImpl: async () => "sha256:previous",
    upgradeServiceImpl: async (_s, svc) => {
      calls.push(`upgrade:${svc.id}`);
      return { ok: true, phase: "up", stdout: "", stderr: "" };
    },
    verifyServiceHealthImpl: async (_s, svc) => {
      calls.push(`verify:${svc.id}`);
      const fails = overrides.unhealthy?.includes(svc.id) && !calls.includes(`restore:${svc.id}`);
      return fails ? { outcome: HEALTH_OUTCOME.FAILED, reason: "Container is exited." } : { outcome: HEALTH_OUTCOME.VERIFIED, reason: "healthy" };
    },
    findRollbackPointImpl: async (_s, svc) => ({ imageId: "sha256:previous", imageRef: `linuxserver/${svc.id}@sha256:previous`, taggedImage: `linuxserver/${svc.id}:latest` }),
    imageExistsLocallyImpl: async () => true,
    setComposeImageImpl: async () => {},
    // A reverted app's compose file names a digest; everything else names the tag.
    readComposeImageImpl: async (svc) => overrides.pinned?.includes(svc.id)
      ? `linuxserver/${svc.id}@sha256:previous`
      : `linuxserver/${svc.id}:latest`,
    generateAndDeployImpl: async (_s, svc) => {
      calls.push(`restore:${svc.id}`);
      return { ok: true, stdout: "", stderr: "", code: 0 };
    },
    appendActivityImpl: async (entry) => {
      calls.push(`activity:${entry.kind}`);
    },
    ...overrides.impls
  });

  // No compose files on disk in these tests.
  service.serviceIsDeployed = async () => true;
  service.clearRollbackPin = async () => {};

  return { service, calls, state, settings };
}

async function settle(service, jobId) {
  await service.jobs.settled(jobId);
  return service.jobs.get(jobId);
}

test("a tick inside the window checks the opted-in apps and upgrades the ones that are ready", async () => {
  const { service, calls, state } = createService();

  const tick = await service.runAutoUpdateTick({ now: at("2026-09-07T08:00:00Z") });
  assert.equal(tick.ran, true);
  const job = await settle(service, tick.jobId);

  assert.equal(job.kind, "auto-update");
  assert.deepEqual(job.steps.map((step) => step.name), ["check", "radarr"]);
  assert.equal(job.status, JOB_STATUS.SUCCEEDED);
  // Only Radarr opted in, so only Radarr was checked or touched.
  assert.ok(calls.includes("check:radarr"));
  assert.ok(!calls.includes("check:sonarr"));
  assert.ok(calls.includes("upgrade:radarr"));
  assert.ok(!calls.includes("upgrade:sonarr"));
  assert.equal(state.auto.lastWindowKey, "2026-09-07");
  assert.equal(state.auto.lastJobId, tick.jobId);
  assert.deepEqual(state.auto.lastSummary, { upgraded: 1, reverted: 0, failed: 0, unchecked: 0, skipped: 0 });
  assert.ok(calls.includes("activity:auto-update"));
});

test("a second tick inside the same window does nothing", async () => {
  const { service } = createService();

  const first = await service.runAutoUpdateTick({ now: at("2026-09-07T08:00:00Z") });
  await settle(service, first.jobId);
  const second = await service.runAutoUpdateTick({ now: at("2026-09-07T08:01:00Z") });

  assert.equal(second.ran, false);
  assert.equal(second.reason, "already-ran");
  assert.equal(service.jobs.list().length, 1);
});

test("the tick stands aside while a job is running, and claims the window only when it runs", async () => {
  const { service, calls } = createService();
  const realList = service.jobs.list.bind(service.jobs);
  service.jobs.list = () => [{ status: "running" }];

  const blocked = await service.runAutoUpdateTick({ now: at("2026-09-07T08:00:00Z") });
  assert.equal(blocked.reason, "job-running");
  assert.ok(!calls.some((call) => call.startsWith("auto-state:")), "the window must stay unclaimed");

  service.jobs.list = realList;
  const ran = await service.runAutoUpdateTick({ now: at("2026-09-07T08:05:00Z") });
  assert.equal(ran.ran, true);
  assert.equal(calls.filter((call) => call.startsWith("auto-state:2026-09-07")).length >= 1, true);
  await settle(service, ran.jobId);
});

test("the tick stands aside while the controller is updating itself", async () => {
  const { service, calls } = createService({ impls: { lease: { isHeld: () => true } } });

  const result = await service.runAutoUpdateTick({ now: at("2026-09-07T08:00:00Z") });

  assert.equal(result.reason, "lease-held");
  assert.ok(!calls.some((call) => call.startsWith("auto-state:")));
});

test("a reverted app is left alone by the nightly run until someone upgrades it by hand", async () => {
  // The nightly check reports it "ready" — the tag has moved on — which is
  // exactly why the status alone cannot be the signal.
  const { service, calls } = createService({ pinned: ["radarr"], checkStatus: { radarr: "ready" } });

  const tick = await service.runAutoUpdateTick({ now: at("2026-09-07T08:00:00Z") });
  const job = await settle(service, tick.jobId);

  const radarr = job.steps.find((step) => step.name === "radarr");
  assert.equal(radarr.status, STEP_STATUS.SKIPPED);
  assert.match(radarr.detail, /manually/);
  assert.ok(!calls.includes("upgrade:radarr"));
});

test("apps that are current are skipped as steps, not hidden", async () => {
  const services = {
    radarr: { id: "radarr", name: "Radarr", containerName: "radarr", autoUpdate: true },
    sonarr: { id: "sonarr", name: "Sonarr", containerName: "sonarr", autoUpdate: true }
  };
  const { service } = createService({ services, checkStatus: { radarr: "ready", sonarr: "current" } });

  const tick = await service.runAutoUpdateTick({ now: at("2026-09-07T08:00:00Z") });
  const job = await settle(service, tick.jobId);

  assert.deepEqual(job.steps.map((step) => step.name), ["check", "radarr", "sonarr"]);
  assert.equal(job.steps.find((step) => step.name === "sonarr").status, STEP_STATUS.SKIPPED);
  assert.equal(job.steps.find((step) => step.name === "sonarr").detail, "Already current.");
  assert.equal(job.steps.find((step) => step.name === "radarr").status, STEP_STATUS.SUCCEEDED);
});

test("an app opted in but not deployed by Keelarr is skipped as such, not as current", async () => {
  // Detected rows cannot opt in from the UI, but a stack removed since it
  // opted in, or a hand-edited settings.json, gets here. "Already current"
  // about a compose file that does not exist would be a lie.
  const services = {
    radarr: { id: "radarr", name: "Radarr", containerName: "radarr", autoUpdate: true },
    ombi: { id: "ombi", name: "Ombi", containerName: "ombi", autoUpdate: true }
  };
  // A "ready" left over from before the stack was removed: the check skips
  // an undeployed app without touching its status, so the stale one stays.
  const { service, calls } = createService({ services, updateState: { ombi: { status: "ready" } } });
  service.serviceIsDeployed = async (svc) => svc.id !== "ombi";

  const tick = await service.runAutoUpdateTick({ now: at("2026-09-07T08:00:00Z") });
  const job = await settle(service, tick.jobId);

  const ombi = job.steps.find((step) => step.name === "ombi");
  assert.equal(ombi.status, STEP_STATUS.SKIPPED);
  assert.equal(ombi.detail, "Not deployed by Keelarr, not touched.");
  assert.ok(!calls.includes("check:ombi"), "an undeployed app is not pulled");
  assert.ok(!calls.includes("upgrade:ombi"));
  assert.equal(job.steps.find((step) => step.name === "radarr").status, STEP_STATUS.SUCCEEDED);
});

test("the run holds the lease, so nothing else can change the stack underneath it", async () => {
  const lease = new MutationLease();
  const heldDuring = [];
  const { service, calls } = createService({
    impls: {
      lease,
      upgradeServiceImpl: async (_s, svc) => {
        calls.push(`upgrade:${svc.id}`);
        heldDuring.push(lease.isHeld());
        assert.throws(() => lease.assertAvailable("Removing an app"), /cannot start while a scheduled update is running/i);
        return { ok: true, phase: "up", stdout: "", stderr: "" };
      }
    }
  });

  const tick = await service.runAutoUpdateTick({ now: at("2026-09-07T08:00:00Z") });
  await settle(service, tick.jobId);

  assert.deepEqual(heldDuring, [true]);
  assert.equal(lease.isHeld(), false, "released when the run is over");
});

test("a failed image check is part of the outcome, not swallowed", async () => {
  const services = {
    radarr: { id: "radarr", name: "Radarr", containerName: "radarr", autoUpdate: true },
    sonarr: { id: "sonarr", name: "Sonarr", containerName: "sonarr", autoUpdate: true }
  };
  const activity = [];
  const { service, calls, state } = createService({
    services,
    impls: {
      checkForUpdatesImpl: async (_s, svc) => {
        calls.push(`check:${svc.id}`);
        return svc.id === "sonarr"
          ? { ok: false, updateStatus: "unknown", stdout: "", stderr: "Error response from daemon: pull access denied" }
          : { ok: true, updateStatus: "ready", stdout: "", stderr: "" };
      },
      appendActivityImpl: async (entry) => {
        activity.push(entry);
      }
    }
  });

  const tick = await service.runAutoUpdateTick({ now: at("2026-09-07T08:00:00Z") });
  const job = await settle(service, tick.jobId);

  const sonarr = job.steps.find((step) => step.name === "sonarr");
  assert.equal(sonarr.status, STEP_STATUS.FAILED);
  assert.match(sonarr.error, /update check failed.*pull access denied/);
  assert.match(job.steps.find((step) => step.name === "check").detail, /1 could not be checked/);
  assert.ok(!calls.includes("upgrade:sonarr"));
  assert.equal(job.steps.find((step) => step.name === "radarr").status, STEP_STATUS.SUCCEEDED);
  assert.deepEqual(state.auto.lastSummary, { upgraded: 1, reverted: 0, failed: 0, unchecked: 1, skipped: 0 });
  const summary = activity.find((entry) => entry.kind === "auto-update");
  assert.equal(summary.level, "warn");
  assert.match(summary.message, /1 could not be checked/);
});

test("a run started by hand records itself without claiming the window", async () => {
  const { service, state } = createService({ autoState: { lastWindowKey: "2026-09-06", lastJobId: "job-old", lastSummary: { upgraded: 3 } } });

  const job = service.startAutoUpdate(
    { ...SETTINGS, tz: "America/Chicago", selectedServiceIds: ["radarr"], services: { radarr: { id: "radarr", name: "Radarr", containerName: "radarr", autoUpdate: true } } },
    [{ id: "radarr", name: "Radarr", containerName: "radarr", autoUpdate: true }],
    { trigger: "manual" }
  );
  await settle(service, job.id);

  assert.equal(state.auto.lastWindowKey, "2026-09-06", "tonight's window is still tonight's");
  assert.equal(state.auto.lastJobId, job.id);
  assert.equal(state.auto.lastTrigger, "manual");
  assert.equal(state.auto.lastSummary.upgraded, 1);
});

test("a scheduled revert leaves the rest of the run going", async () => {
  const services = {
    radarr: { id: "radarr", name: "Radarr", containerName: "radarr", autoUpdate: true },
    sonarr: { id: "sonarr", name: "Sonarr", containerName: "sonarr", autoUpdate: true }
  };
  const { service, calls, state } = createService({ services, autoRevert: true, unhealthy: ["radarr"] });

  const tick = await service.runAutoUpdateTick({ now: at("2026-09-07T08:00:00Z") });
  const job = await settle(service, tick.jobId);

  const radarr = job.steps.find((step) => step.name === "radarr");
  assert.equal(radarr.status, STEP_STATUS.FAILED);
  assert.match(radarr.error, /Reverted to/);
  assert.ok(calls.includes("restore:radarr"));
  assert.equal(job.steps.find((step) => step.name === "sonarr").status, STEP_STATUS.SUCCEEDED);
  assert.deepEqual(state.auto.lastSummary, { upgraded: 1, reverted: 1, failed: 0, unchecked: 0, skipped: 0 });
});

test("nothing opted in claims the window and creates no job", async () => {
  const services = { radarr: { id: "radarr", name: "Radarr", containerName: "radarr", autoUpdate: false } };
  const { service, state } = createService({ services });

  const result = await service.runAutoUpdateTick({ now: at("2026-09-07T08:00:00Z") });

  assert.equal(result.reason, "nothing-opted-in");
  assert.equal(state.auto.lastWindowKey, "2026-09-07");
  assert.deepEqual(state.auto.lastSummary, { reason: "nothing-opted-in" });
  assert.equal(service.jobs.list().length, 0);
});

test("a failing tick does not take the controller down", async () => {
  const { service } = createService({ impls: { loadSettingsImpl: async () => { throw new Error("disk gone"); } } });
  let tick;
  const stop = service.startAutoUpdateSchedule({
    setIntervalImpl: (fn) => { tick = fn; return { unref() {} }; }
  });

  await assert.doesNotReject(() => tick());
  stop();
});

test("the schedule ticks on the injected timer and can be stopped", async () => {
  const { service } = createService();
  const ticks = [];
  let fn = null;
  const stop = service.startAutoUpdateSchedule({
    nowImpl: () => at("2026-09-07T08:00:00Z"),
    setIntervalImpl: (callback, ms) => { fn = callback; ticks.push(ms); return { unref() {} }; }
  });

  assert.deepEqual(ticks, [60_000]);
  await fn();
  assert.equal(service.jobs.list().length, 1);
  await settle(service, service.jobs.list()[0].id);
  stop();
});

test("describing the schedule reports who opted in and when it next runs", async () => {
  const { service } = createService({ autoState: { lastWindowKey: "2026-09-06", lastRunAt: "2026-09-06T08:00:00.000Z", lastSummary: { upgraded: 2 } } });

  const described = await service.describeAutoUpdate();

  assert.equal(described.enabled, true);
  assert.equal(described.time, "03:00");
  assert.equal(described.tzValid, true);
  assert.equal(described.toleranceMinutes, 30);
  assert.deepEqual(described.optedIn, ["radarr"]);
  assert.equal(described.lastWindowKey, "2026-09-06");
  assert.deepEqual(described.lastSummary, { upgraded: 2 });
  assert.match(described.nextRunAt, /^\d{4}-\d{2}-\d{2}T/);
});
