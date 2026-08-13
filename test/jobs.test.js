import test from "node:test";
import assert from "node:assert/strict";

import path from "node:path";
import { tmpdir } from "node:os";

import { JOB_STATUS, JobRegistry, STEP_STATUS, buildJobSnapshot } from "../src/lib/jobs.js";
import { createLogger } from "../src/lib/logger.js";

const noop = () => {};
export const silentLogger = createLogger({
  level: "error",
  filePath: path.join(tmpdir(), "keelarr-test.log"),
  consoleImpl: { debug: noop, info: noop, warn: noop, error: noop, log: noop }
});

function createRegistry(overrides = {}) {
  let counter = 0;
  return new JobRegistry({
    logger: silentLogger,
    createId: () => `job-${++counter}`,
    now: () => "2026-08-05T00:00:00.000Z",
    ...overrides
  });
}

async function settle(job) {
  while (job.status === JOB_STATUS.PENDING || job.status === JOB_STATUS.RUNNING) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  return job;
}

test("a created job exposes its full step plan before anything runs", () => {
  const registry = createRegistry();
  const job = registry.create({
    kind: "cutover",
    subject: { containerId: "abc" },
    steps: [{ name: "stop", label: "Stop it" }, { name: "start", label: "Start it" }]
  });

  const snapshot = buildJobSnapshot(job);
  assert.equal(snapshot.status, JOB_STATUS.PENDING);
  assert.deepEqual(snapshot.steps.map((step) => step.name), ["stop", "start"]);
  assert.ok(snapshot.steps.every((step) => step.status === STEP_STATUS.PENDING));
  assert.equal(snapshot.steps[0].label, "Stop it");
});

test("a successful run records step transitions and the handler result", async () => {
  const registry = createRegistry();
  const job = registry.create({ kind: "cutover", subject: { containerId: "abc" }, steps: ["stop", "start"] });

  registry.start(job, async (ctx) => {
    await ctx.step("stop", async () => ({ detail: "stopped" }));
    await ctx.step("start", async () => ({ detail: "started" }));
    return { outcome: "verified" };
  });

  await settle(job);

  assert.equal(job.status, JOB_STATUS.SUCCEEDED);
  assert.deepEqual(job.result, { outcome: "verified" });
  assert.deepEqual(job.steps.map((step) => step.status), [STEP_STATUS.SUCCEEDED, STEP_STATUS.SUCCEEDED]);
  assert.equal(job.steps[0].detail, "stopped");
});

test("a thrown handler fails the job and never leaves a step stuck running", async () => {
  const registry = createRegistry();
  const job = registry.create({ kind: "cutover", subject: { containerId: "abc" }, steps: ["stop", "start"] });

  registry.start(job, async (ctx) => {
    await ctx.step("stop", async () => {
      throw new Error("stop failed");
    });
  });

  await settle(job);

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.equal(job.error.message, "stop failed");
  assert.equal(job.steps[0].status, STEP_STATUS.FAILED);
  assert.equal(job.steps[0].error, "stop failed");
  // The step that never ran stays pending rather than being marked failed.
  assert.equal(job.steps[1].status, STEP_STATUS.PENDING);
});

test("skipped steps are reported distinctly from succeeded ones", async () => {
  const registry = createRegistry();
  const job = registry.create({ kind: "cutover", subject: { containerId: "abc" }, steps: ["deploy", "revert"] });

  registry.start(job, async (ctx) => {
    await ctx.step("deploy", async () => ({ detail: "up" }));
    ctx.skip("revert", "Not needed.");
  });

  await settle(job);

  assert.equal(job.steps[1].status, STEP_STATUS.SKIPPED);
  assert.equal(job.steps[1].detail, "Not needed.");
});

test("a second job for the same subject is refused while the first is live", async () => {
  const registry = createRegistry();
  const first = registry.create({ kind: "cutover", subject: { containerId: "abc" }, steps: ["stop"] });

  assert.throws(
    () => registry.create({ kind: "cutover", subject: { containerId: "abc" }, steps: ["stop"] }),
    /already running/
  );

  // A different subject is unaffected.
  registry.create({ kind: "cutover", subject: { containerId: "def" }, steps: ["stop"] });

  registry.start(first, async (ctx) => {
    await ctx.step("stop", async () => ({ detail: "done" }));
  });
  await settle(first);

  // Once finished, the subject is free again.
  registry.create({ kind: "cutover", subject: { containerId: "abc" }, steps: ["stop"] });
});

test("referencing an undeclared step is an error rather than a silent no-op", async () => {
  const registry = createRegistry();
  const job = registry.create({ kind: "cutover", subject: { containerId: "abc" }, steps: ["stop"] });

  registry.start(job, async (ctx) => {
    await ctx.step("nope", async () => ({}));
  });

  await settle(job);
  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.match(job.error.message, /declared no step named nope/);
});

test("prune drops finished jobs once the registry is over its cap", async () => {
  const registry = createRegistry({ maxJobs: 2 });

  for (const containerId of ["a", "b", "c", "d"]) {
    const job = registry.create({ kind: "cutover", subject: { containerId }, steps: ["stop"] });
    registry.start(job, async (ctx) => {
      await ctx.step("stop", async () => ({ detail: "done" }));
    });
    await settle(job);
  }

  assert.ok(registry.list().length <= 2);
});

function createPersistentRegistry(store, overrides = {}) {
  let counter = 0;
  return new JobRegistry({
    logger: silentLogger,
    persist: true,
    createId: () => `job-${++counter}`,
    now: () => "2026-08-05T00:00:00.000Z",
    readJobsImpl: async () => store.jobs,
    writeJobsImpl: async (jobs) => {
      store.jobs = jobs;
      store.writes += 1;
    },
    ...overrides
  });
}

test("a completed job survives a restart", async () => {
  const store = { jobs: [], writes: 0 };
  const first = createPersistentRegistry(store);
  const job = first.create({ kind: "cutover", subject: { containerId: "abc" }, steps: ["stop"] });

  first.start(job, async (ctx) => {
    await ctx.step("stop", async () => ({ detail: "stopped" }));
    return { outcome: "verified" };
  });
  await settle(job);
  await first.flush();

  const second = createPersistentRegistry(store);
  await second.hydrate();
  const restored = second.get("job-1");

  assert.equal(restored.status, JOB_STATUS.SUCCEEDED);
  assert.deepEqual(restored.result, { outcome: "verified" });
  assert.equal(restored.steps[0].detail, "stopped");
});

test("a job still marked running after a restart is reported as interrupted, not live", async () => {
  const store = { jobs: [], writes: 0 };

  // Simulate a process that died mid-step: the record is left mid-flight.
  store.jobs = [{
    id: "job-9",
    kind: "cutover",
    subject: { containerId: "abc" },
    status: JOB_STATUS.RUNNING,
    steps: [
      { name: "stop", label: "Stop", status: STEP_STATUS.SUCCEEDED, detail: null, error: null, startedAt: null, finishedAt: null },
      { name: "deploy", label: "Deploy", status: STEP_STATUS.RUNNING, detail: null, error: null, startedAt: null, finishedAt: null }
    ],
    result: null,
    error: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    startedAt: "2026-08-05T00:00:00.000Z",
    finishedAt: null
  }];

  const registry = createPersistentRegistry(store);
  await registry.hydrate();
  const restored = registry.get("job-9");

  assert.equal(restored.status, JOB_STATUS.FAILED);
  assert.equal(restored.error.details.interrupted, true);
  assert.match(restored.error.message, /restarted while this job was running/);
  // The step that was mid-flight must not stay "running" forever.
  assert.equal(restored.steps[1].status, STEP_STATUS.FAILED);
  assert.equal(restored.steps[0].status, STEP_STATUS.SUCCEEDED);
  // The reconciled state is written back so the next restart is consistent.
  assert.equal(store.jobs.find((entry) => entry.id === "job-9").status, JOB_STATUS.FAILED);
});

test("an interrupted subject can be retried after hydration", async () => {
  const store = { jobs: [] };
  store.jobs = [{
    id: "job-9",
    kind: "cutover",
    subject: { containerId: "abc" },
    status: JOB_STATUS.RUNNING,
    steps: [],
    result: null,
    error: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    startedAt: "2026-08-05T00:00:00.000Z",
    finishedAt: null
  }];

  const registry = createPersistentRegistry(store);
  await registry.hydrate();

  // The stale job is terminal, so the concurrency guard must not block a retry.
  registry.create({ kind: "cutover", subject: { containerId: "abc" }, steps: ["stop"] });
});

test("persistence failures never break a running job", async () => {
  const store = { jobs: [], writes: 0 };
  const registry = createPersistentRegistry(store, {
    writeJobsImpl: async () => {
      throw new Error("disk full");
    }
  });

  const job = registry.create({ kind: "cutover", subject: { containerId: "abc" }, steps: ["stop"] });
  registry.start(job, async (ctx) => {
    await ctx.step("stop", async () => ({ detail: "stopped" }));
    return { outcome: "verified" };
  });
  await settle(job);

  assert.equal(job.status, JOB_STATUS.SUCCEEDED);
});

test("a registry without persistence never touches the store", async () => {
  const store = { jobs: [], writes: 0 };
  const registry = createPersistentRegistry(store, { persist: false });
  const job = registry.create({ kind: "cutover", subject: { containerId: "abc" }, steps: ["stop"] });

  registry.start(job, async (ctx) => {
    await ctx.step("stop", async () => ({ detail: "stopped" }));
  });
  await settle(job);
  await registry.flush();

  assert.equal(store.writes, 0);
});

test("a job whose step failed does not report success", async () => {
  // Upgrade-all catches per-service failures so one bad service cannot strand
  // the rest, then returns normally — and the job was recording that as
  // success while the same run logged failed:1 at error level.
  const registry = createRegistry();
  const job = registry.create({
    kind: "upgrade-all",
    subject: { serviceId: "*" },
    steps: [{ name: "sonarr", label: "Upgrade Sonarr" }, { name: "trailarr", label: "Upgrade Trailarr" }]
  });

  registry.start(job, async (ctx) => {
    await ctx.step("sonarr", async () => ({ detail: "Upgraded." }));

    try {
      await ctx.step("trailarr", async () => {
        throw new Error("Image pull stalled.");
      });
    } catch {
      // Swallowed on purpose: this is what the real handler does.
    }

    return { upgraded: 1, failed: 1 };
  });
  await settle(job);

  const finished = registry.get(job.id);

  assert.equal(finished.status, "failed");
  assert.match(finished.error.message, /Upgrade Trailarr/);
  // The result survives, because which parts did work is the useful half of a
  // partial failure.
  assert.deepEqual(finished.result, { upgraded: 1, failed: 1 });
});

test("a job with every step skipped still succeeds", async () => {
  const registry = createRegistry();
  const job = registry.create({
    kind: "upgrade-all",
    subject: { serviceId: "*" },
    steps: [{ name: "radarr", label: "Upgrade Radarr" }]
  });

  registry.start(job, async (ctx) => {
    ctx.skip("radarr", "Already current.");
    return { upgraded: 0 };
  });
  await settle(job);

  assert.equal(registry.get(job.id).status, "succeeded");
});
