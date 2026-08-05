import test from "node:test";
import assert from "node:assert/strict";

import path from "node:path";
import { tmpdir } from "node:os";

import { JOB_STATUS, JobRegistry, STEP_STATUS, buildJobSnapshot } from "../src/lib/jobs.js";
import { createLogger } from "../src/lib/logger.js";

const noop = () => {};
export const silentLogger = createLogger({
  level: "error",
  filePath: path.join(tmpdir(), "stackarr-test.log"),
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
