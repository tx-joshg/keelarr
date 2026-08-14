import test from "node:test";
import assert from "node:assert/strict";

import { DemoKeelarrAppService } from "../src/lib/demo-service.js";

test("demo service exposes a simulated dashboard state", async () => {
  const service = new DemoKeelarrAppService();
  const state = await service.buildState();

  assert.equal(state.meta.mode, "demo");
  assert.equal(state.services.length > 0, true);
  assert.equal(state.services.every((item) => item.appUrl.startsWith("/demo/apps/")), true);
});

test("demo service can generate a managed draft from an import candidate", async () => {
  const service = new DemoKeelarrAppService();
  const result = await service.adoptImportAsDraft("trailarrdemo");
  const scan = await service.scanImportInventory();

  assert.equal(result.ok, true);
  assert.equal(result.preview.target.serviceId, "trailarr");
  assert.equal(result.generated.serviceId, "trailarr");
  assert.match(result.generated.reviewSummaryPath, /import-summary\.json$/);
  assert.match(result.generated.reviewNotesPath, /IMPORT-REVIEW\.md$/);
  assert.equal(scan.items.find((item) => item.containerId === "trailarrdemo")?.adoptedDraft, true);
});

// Waits on the job rather than a tick budget, for the same reason as
// settleJobById in rollback.test.js: a tick count is not a measure of how long
// real work takes, and gets shorter the busier the machine is.
async function settleJob(service, jobId) {
  await service.jobs.settled(jobId);
  const { job } = await service.getJob(jobId);
  return job;
}

function serviceState(state, id) {
  return state.services.find((item) => item.id === id);
}

test("demo dashboard reports the management lifecycle the cutover UI keys off", async () => {
  const service = new DemoKeelarrAppService();

  // Detected: a live container exists, but no draft has been generated.
  assert.equal(serviceState(await service.buildState(), "trailarr").managementState, "detected");

  await service.adoptImportAsDraft("trailarrdemo");
  const drafted = serviceState(await service.buildState(), "trailarr");
  assert.equal(drafted.managementState, "draft");
  assert.equal(drafted.managedMode, "imported-draft");
  assert.equal(drafted.rollbackContainerName, null);

  const started = await service.startCutover("trailarrdemo", { confirmContainerName: "trailarr" });
  await settleJob(service, started.job.id);

  const managed = serviceState(await service.buildState(), "trailarr");
  assert.equal(managed.managementState, "managed");
  assert.equal(managed.managedMode, "imported");
  // The revert control is offered only while the rollback container exists.
  assert.equal(managed.rollbackContainerName, "trailarr-keelarr-rollback");
});

test("demo cutover refuses a confirmation that does not match the container", async () => {
  const service = new DemoKeelarrAppService();
  await service.adoptImportAsDraft("trailarrdemo");

  await assert.rejects(
    () => service.startCutover("trailarrdemo", { confirmContainerName: "nope" }),
    /confirmation does not match/
  );
});

test("demo cutover requires a generated draft first", async () => {
  const service = new DemoKeelarrAppService();

  await assert.rejects(
    () => service.startCutover("trailarrdemo", { confirmContainerName: "trailarr" }),
    /Generate the managed draft/
  );
});

test("demo revert clears the rollback container and returns the service to draft", async () => {
  const service = new DemoKeelarrAppService();
  await service.adoptImportAsDraft("trailarrdemo");
  const started = await service.startCutover("trailarrdemo", { confirmContainerName: "trailarr" });
  await settleJob(service, started.job.id);

  const reverted = await service.startCutoverRevert("trailarr", { confirmContainerName: "trailarr" });
  await settleJob(service, reverted.job.id);

  const after = serviceState(await service.buildState(), "trailarr");
  assert.equal(after.managementState, "draft");
  assert.equal(after.rollbackContainerName, null);
});
