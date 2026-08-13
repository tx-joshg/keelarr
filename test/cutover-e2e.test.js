import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { CutoverService } from "../src/lib/app-services/cutover-service.js";
import { JOB_STATUS, JobRegistry } from "../src/lib/jobs.js";
import { HEALTH_OUTCOME } from "../src/lib/health.js";
import { createLogger } from "../src/lib/logger.js";
import { normalizeSettings } from "../src/lib/store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const stubDocker = path.join(here, "fixtures", "stub-docker.mjs");

const noop = () => {};
const silentLogger = createLogger({
  level: "error",
  filePath: path.join(tmpdir(), "keelarr-test.log"),
  consoleImpl: { debug: noop, info: noop, warn: noop, error: noop, log: noop }
});

const COMPOSE_YAML = `name: trailarr
services:
  trailarr:
    image: nandyalu/trailarr:latest
    container_name: trailarr
    restart: unless-stopped
`;

const liveItem = {
  containerId: "c-trailarr",
  containerName: "trailarr",
  serviceId: "trailarr",
  serviceName: "Trailarr",
  image: "nandyalu/trailarr:latest",
  recognized: true,
  adoptable: true
};

/**
 * Wires the real runtime primitives and the real health poller to a stub
 * docker binary. Only the inventory scan and settings persistence are faked,
 * so this exercises actual argv construction and inspect-format parsing.
 */
async function createEnvironment(t, stateOverrides = {}, verifyOptions = { intervalMs: 5, timeoutMs: 3_000 }) {
  const workDir = await mkdtemp(path.join(tmpdir(), "keelarr-cutover-"));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const stackDir = path.join(workDir, "trailarr");
  const composePath = path.join(stackDir, "compose.yml");
  const envPath = path.join(stackDir, ".env");
  const statePath = path.join(workDir, "docker-state.json");

  await mkdir(stackDir, { recursive: true });
  await writeFile(composePath, COMPOSE_YAML, "utf8");
  await writeFile(envPath, "PUID=1000\n", "utf8");
  await writeFile(statePath, JSON.stringify({
    containers: {
      trailarr: { status: "running", health: "healthy", imageId: "sha256:old-image" }
    },
    repoDigest: "nandyalu/trailarr@sha256:olddigest",
    log: [],
    ...stateOverrides
  }, null, 2));

  process.env.STUB_DOCKER_STATE = statePath;
  t.after(() => {
    delete process.env.STUB_DOCKER_STATE;
  });

  const settings = normalizeSettings({
    initialized: true,
    dockerBin: stubDocker,
    stackRoot: workDir,
    selectedServiceIds: ["trailarr"],
    serviceOverrides: {
      trailarr: { mode: "imported-draft", image: "nandyalu/trailarr:latest", containerName: "trailarr" }
    }
  });
  settings.services.trailarr.stackDir = stackDir;
  settings.services.trailarr.composePath = composePath;
  settings.services.trailarr.envPath = envPath;
  // No app probing in this harness; the container healthcheck decides.
  settings.services.trailarr.appUrl = "";

  const saved = [];
  const service = new CutoverService({
    logger: silentLogger,
    jobs: new JobRegistry({ logger: silentLogger }),
    loadSettingsImpl: async () => settings,
    saveSettingsImpl: async (next) => {
      saved.push(next);
      return next;
    },
    scanDockerInventoryImpl: async () => ({ items: [liveItem] }),
    buildImportPreviewImpl: async () => ({ supported: true, adoptable: true }),
    buildImportDraftArtifactsImpl: () => ({ composeYaml: COMPOSE_YAML }),
    appendActivityImpl: async () => {},
    verifyOptions
  });

  const readState = async () => JSON.parse(await readFile(statePath, "utf8"));

  return { service, settings, saved, readState, workDir, stackDir };
}

async function settle(job) {
  while (job.status === JOB_STATUS.PENDING || job.status === JOB_STATUS.RUNNING) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  return job;
}

test("end to end: a real cutover drives docker through stop, rename, and compose up", async (t) => {
  const { service, readState, saved } = await createEnvironment(t);

  const job = await settle(service.startCutover("c-trailarr", { confirmContainerName: "trailarr" }));

  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);
  assert.equal(job.result.outcome, HEALTH_OUTCOME.VERIFIED);

  const state = await readState();

  // The replacement holds the original name; the old container survives
  // under the rollback name and was never removed.
  assert.equal(state.containers.trailarr.composeManaged, true);
  assert.equal(state.containers["trailarr-keelarr-rollback"].status, "exited");
  assert.equal(state.containers["trailarr-keelarr-rollback"].imageId, "sha256:old-image");

  const commands = state.log.map((entry) => entry.split(" ")[0]);
  assert.deepEqual(
    commands.filter((name) => ["stop", "rename", "compose"].includes(name)),
    ["stop", "rename", "compose"]
  );
  assert.ok(state.log.some((entry) => entry === "rename trailarr trailarr-keelarr-rollback"));
  assert.ok(state.log.some((entry) => entry.startsWith("compose -f") && entry.endsWith("up -d")));
  assert.ok(!state.log.some((entry) => entry.startsWith("rm ")));

  assert.equal(saved.at(-1).serviceOverrides.trailarr.mode, "imported");
});

test("end to end: the backup captures the pre-cutover image before compose replaces it", async (t) => {
  const { service, workDir } = await createEnvironment(t);

  await settle(service.startCutover("c-trailarr", { confirmContainerName: "trailarr" }));

  const backupsRoot = path.join(workDir, ".keelarr-backups", "trailarr");
  const [stamp] = await readdir(backupsRoot);
  const rollback = JSON.parse(await readFile(path.join(backupsRoot, stamp, "rollback.json"), "utf8"));

  assert.equal(rollback.imageId, "sha256:old-image");
  assert.equal(rollback.imageRepoDigest, "nandyalu/trailarr@sha256:olddigest");
});

test("end to end: a compose failure restores the original container under its original name", async (t) => {
  const { service, readState } = await createEnvironment(t, { failComposeUp: true });

  const job = await settle(service.startCutover("c-trailarr", { confirmContainerName: "trailarr" }));

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.equal(job.error.details.reverted, true);

  const state = await readState();
  assert.equal(state.containers.trailarr.status, "running");
  assert.equal(state.containers.trailarr.imageId, "sha256:old-image");
  assert.equal(state.containers["trailarr-keelarr-rollback"], undefined);
});

test("end to end: a container that comes up unhealthy is rolled back", async (t) => {
  // Unhealthy stays pending until the deadline, so keep the window short.
  const { service, readState } = await createEnvironment(t, { composedHealth: "unhealthy" }, {
    intervalMs: 5,
    timeoutMs: 200
  });

  const job = await settle(service.startCutover("c-trailarr", { confirmContainerName: "trailarr" }));

  assert.equal(job.status, JOB_STATUS.FAILED);

  const state = await readState();
  assert.equal(state.containers.trailarr.status, "running");
  assert.equal(state.containers.trailarr.imageId, "sha256:old-image");
  assert.equal(state.containers["trailarr-keelarr-rollback"], undefined);
});

test("end to end: revert puts the original container back after a successful cutover", async (t) => {
  const { service, settings, readState } = await createEnvironment(t);

  await settle(service.startCutover("c-trailarr", { confirmContainerName: "trailarr" }));

  // Mirror what finalize persisted, so revert can find the rollback container.
  settings.serviceOverrides.trailarr.mode = "imported";
  settings.serviceOverrides.trailarr.rollbackContainerName = "trailarr-keelarr-rollback";

  const job = await settle(service.startRevert("trailarr", { confirmContainerName: "trailarr" }));

  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);

  const state = await readState();
  assert.equal(state.containers.trailarr.status, "running");
  assert.equal(state.containers.trailarr.imageId, "sha256:old-image");
  assert.equal(state.containers.trailarr.composeManaged, undefined);
  assert.equal(state.containers["trailarr-keelarr-rollback"], undefined);
});
