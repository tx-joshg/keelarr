import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";

import { CutoverService, rollbackNameFor } from "../src/lib/app-services/cutover-service.js";
import { JOB_STATUS, JobRegistry, STEP_STATUS } from "../src/lib/jobs.js";
import { HEALTH_OUTCOME } from "../src/lib/health.js";
import { createLogger } from "../src/lib/logger.js";
import { normalizeSettings } from "../src/lib/store.js";

const noop = () => {};
const silentLogger = createLogger({
  level: "error",
  filePath: path.join(tmpdir(), "keelarr-test.log"),
  consoleImpl: { debug: noop, info: noop, warn: noop, error: noop, log: noop }
});

const DRAFT_YAML = "name: trailarr\nservices:\n  trailarr:\n    image: nandyalu/trailarr:latest\n";

const liveItem = {
  containerId: "c-trailarr",
  containerName: "trailarr",
  serviceId: "trailarr",
  serviceName: "Trailarr",
  image: "nandyalu/trailarr:latest",
  recognized: true,
  adoptable: true
};

function buildSettings() {
  return normalizeSettings({
    initialized: true,
    stackRoot: "/share/Container/docker",
    configRoot: "/share/Container",
    mediaRoot: "/share/Media",
    downloadsRoot: "/share/Media/Downloads",
    selectedServiceIds: ["trailarr"],
    serviceOverrides: {
      trailarr: {
        mode: "imported-draft",
        image: "nandyalu/trailarr:latest",
        port: 7889,
        containerName: "trailarr"
      }
    }
  });
}

/**
 * Builds a service wired entirely to fakes, and records every docker-facing
 * call in order so tests can assert the sequence, not just the outcome.
 */
function createHarness(overrides = {}) {
  const calls = [];
  const saved = [];
  const ok = { ok: true, stdout: "", stderr: "", code: 0 };

  const service = new CutoverService({
    logger: silentLogger,
    jobs: new JobRegistry({ logger: silentLogger }),
    loadSettingsImpl: async () => buildSettings(),
    scanDockerInventoryImpl: async () => ({ items: [liveItem] }),
    buildImportPreviewImpl: async () => ({ supported: true, adoptable: true }),
    buildImportDraftArtifactsImpl: () => ({ composeYaml: DRAFT_YAML }),
    readFileImpl: async () => DRAFT_YAML,
    containerExistsImpl: async (_settings, name) => {
      calls.push(`exists:${name}`);
      return overrides.rollbackAlreadyExists === true;
    },
    backupServiceImpl: async () => {
      calls.push("backup");
      return { backupDir: "/backups/trailarr/x", rollback: { imageId: "sha256:old" } };
    },
    stopContainerImpl: async (_settings, name) => {
      calls.push(`stop:${name}`);
      return ok;
    },
    renameContainerImpl: async (_settings, from, to) => {
      calls.push(`rename:${from}->${to}`);
      return ok;
    },
    startContainerImpl: async (_settings, name) => {
      calls.push(`start:${name}`);
      return ok;
    },
    generateAndDeployImpl: async () => {
      calls.push("compose-up");
      return overrides.deployResult || ok;
    },
    composeDownImpl: async () => {
      calls.push("compose-down");
      return ok;
    },
    verifyServiceHealthImpl: async () => {
      calls.push("verify");
      return overrides.health || { outcome: HEALTH_OUTCOME.VERIFIED, reason: "healthy" };
    },
    saveSettingsImpl: async (next) => {
      saved.push(next);
      return next;
    },
    appendActivityImpl: async () => {},
    ...overrides.serviceOverrides
  });

  return { service, calls, saved };
}

async function settle(job) {
  while (job.status === JOB_STATUS.PENDING || job.status === JOB_STATUS.RUNNING) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  return job;
}

function stepByName(job, name) {
  return job.steps.find((step) => step.name === name);
}

test("a verified cutover stops, renames, deploys, and records managed state in order", async () => {
  const { service, calls, saved } = createHarness();
  const job = await settle(service.startCutover("c-trailarr", { confirmContainerName: "trailarr" }));

  assert.equal(job.status, JOB_STATUS.SUCCEEDED);
  assert.equal(job.result.outcome, HEALTH_OUTCOME.VERIFIED);

  // The rename must land between the stop and the compose up: the old
  // container has to release the name before Compose can claim it.
  assert.deepEqual(calls, [
    "exists:trailarr-keelarr-rollback",
    "backup",
    "stop:trailarr",
    "rename:trailarr->trailarr-keelarr-rollback",
    "compose-up",
    "verify"
  ]);

  assert.equal(stepByName(job, "revert").status, STEP_STATUS.SKIPPED);
  assert.equal(saved.at(-1).serviceOverrides.trailarr.mode, "imported");
  assert.equal(saved.at(-1).serviceOverrides.trailarr.rollbackContainerName, "trailarr-keelarr-rollback");
});

test("the original container is preserved, never deleted, on success", async () => {
  const { service, calls } = createHarness();
  const job = await settle(service.startCutover("c-trailarr", { confirmContainerName: "trailarr" }));

  assert.ok(!calls.some((call) => call.startsWith("rm")));
  assert.match(job.result.cleanupHint, /preserved as trailarr-keelarr-rollback/);
});

test("a failed compose up restores the original container and fails the job", async () => {
  const { service, calls, saved } = createHarness({
    deployResult: { ok: false, stdout: "", stderr: "port in use", code: 1 }
  });
  const job = await settle(service.startCutover("c-trailarr", { confirmContainerName: "trailarr" }));

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.equal(job.error.details.reverted, true);
  assert.deepEqual(calls.slice(-4), [
    "compose-up",
    "compose-down",
    "rename:trailarr-keelarr-rollback->trailarr",
    "start:trailarr"
  ]);
  // A failed cutover must not leave the service marked as cut over.
  assert.equal(saved.length, 0);
});

test("a container that comes up dead is rolled back automatically", async () => {
  const { service, calls, saved } = createHarness({
    health: { outcome: HEALTH_OUTCOME.FAILED, reason: "Container is exited." }
  });
  const job = await settle(service.startCutover("c-trailarr", { confirmContainerName: "trailarr" }));

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.equal(stepByName(job, "revert").status, STEP_STATUS.SUCCEEDED);
  assert.deepEqual(calls.slice(-3), [
    "compose-down",
    "rename:trailarr-keelarr-rollback->trailarr",
    "start:trailarr"
  ]);
  assert.equal(saved.length, 0);
});

test("an unverified but running container is kept, with the rollback container left in place", async () => {
  const { service, calls, saved } = createHarness({
    health: { outcome: HEALTH_OUTCOME.UNVERIFIED, reason: "No healthcheck and no app response." }
  });
  const job = await settle(service.startCutover("c-trailarr", { confirmContainerName: "trailarr" }));

  // Succeeds, but the outcome is reported honestly and nothing was reverted.
  assert.equal(job.status, JOB_STATUS.SUCCEEDED);
  assert.equal(job.result.outcome, HEALTH_OUTCOME.UNVERIFIED);
  assert.ok(!calls.includes("compose-down"));
  assert.equal(saved.at(-1).serviceOverrides.trailarr.mode, "imported");
});

test("a mismatched confirmation refuses before touching the container", async () => {
  const { service, calls } = createHarness();
  const job = await settle(service.startCutover("c-trailarr", { confirmContainerName: "wrong" }));

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.match(job.error.message, /confirmation does not match/);
  assert.deepEqual(calls, []);
});

test("a draft that no longer matches the live container blocks the cutover", async () => {
  const { service, calls } = createHarness({
    serviceOverrides: {
      readFileImpl: async () => "name: trailarr\nservices:\n  trailarr:\n    image: nandyalu/trailarr:OLD\n"
    }
  });
  const job = await settle(service.startCutover("c-trailarr", { confirmContainerName: "trailarr" }));

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.match(job.error.message, /no longer matches the reviewed draft/);
  assert.deepEqual(calls, []);
});

test("a leftover rollback container blocks the cutover before anything is stopped", async () => {
  const { service, calls } = createHarness({ rollbackAlreadyExists: true });
  const job = await settle(service.startCutover("c-trailarr", { confirmContainerName: "trailarr" }));

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.match(job.error.message, /still exists/);
  assert.deepEqual(calls, ["exists:trailarr-keelarr-rollback"]);
});

test("a service without a reviewed draft cannot be cut over", async () => {
  const { service } = createHarness({
    serviceOverrides: {
      loadSettingsImpl: async () => normalizeSettings({
        initialized: true,
        selectedServiceIds: ["trailarr"]
      })
    }
  });
  const job = await settle(service.startCutover("c-trailarr", { confirmContainerName: "trailarr" }));

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.match(job.error.message, /no reviewed import draft/);
});

test("revert takes compose down, restores the original container, and clears cutover state", async () => {
  const { service, calls, saved } = createHarness({
    serviceOverrides: {
      loadSettingsImpl: async () => normalizeSettings({
        initialized: true,
        stackRoot: "/share/Container/docker",
        selectedServiceIds: ["trailarr"],
        serviceOverrides: {
          trailarr: {
            mode: "imported",
            containerName: "trailarr",
            rollbackContainerName: "trailarr-keelarr-rollback"
          }
        }
      }),
      containerExistsImpl: async (_settings, name) => {
        calls.push(`exists:${name}`);
        return true;
      }
    }
  });

  const job = await settle(service.startRevert("trailarr", { confirmContainerName: "trailarr" }));

  assert.equal(job.status, JOB_STATUS.SUCCEEDED);
  assert.deepEqual(calls, [
    "exists:trailarr-keelarr-rollback",
    "compose-down",
    "rename:trailarr-keelarr-rollback->trailarr",
    "start:trailarr",
    "verify"
  ]);
  assert.equal(saved.at(-1).serviceOverrides.trailarr.mode, "imported-draft");
  assert.equal(saved.at(-1).serviceOverrides.trailarr.rollbackContainerName, null);
});

test("revert refuses when there is no rollback container to restore", async () => {
  const { service } = createHarness({
    serviceOverrides: {
      loadSettingsImpl: async () => normalizeSettings({
        initialized: true,
        selectedServiceIds: ["trailarr"],
        serviceOverrides: { trailarr: { mode: "imported", containerName: "trailarr" } }
      }),
      containerExistsImpl: async () => false
    }
  });

  const job = await settle(service.startRevert("trailarr", { confirmContainerName: "trailarr" }));

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.match(job.error.message, /cannot be reverted automatically/);
});

test("rollbackNameFor is stable and suffix-based", () => {
  assert.equal(rollbackNameFor("sabnzbd"), "sabnzbd-keelarr-rollback");
});
