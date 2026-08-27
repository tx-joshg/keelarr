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
