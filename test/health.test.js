import test from "node:test";
import assert from "node:assert/strict";

import { HEALTH_OUTCOME, classifyHealthSnapshot, isProbeableAppUrl, verifyServiceHealth } from "../src/lib/health.js";

const service = {
  containerName: "trailarr",
  appUrl: "http://nas.local:7889",
  healthStatuses: [200, 302, 401]
};

test("a healthy container healthcheck is decisive", () => {
  const verdict = classifyHealthSnapshot({ exists: true, status: "running", healthStatus: "healthy" });

  assert.equal(verdict.outcome, HEALTH_OUTCOME.VERIFIED);
});

test("an exited container fails immediately", () => {
  const verdict = classifyHealthSnapshot({ exists: true, status: "exited", healthStatus: null });

  assert.equal(verdict.outcome, HEALTH_OUTCOME.FAILED);
});

test("an unhealthy or starting healthcheck stays pending so it can settle", () => {
  assert.equal(
    classifyHealthSnapshot({ exists: true, status: "running", healthStatus: "unhealthy" }).outcome,
    "pending"
  );
  assert.equal(
    classifyHealthSnapshot({ exists: true, status: "running", healthStatus: "starting" }).outcome,
    "pending"
  );
});

test("an app that answers acceptably verifies a container with no healthcheck", () => {
  const verdict = classifyHealthSnapshot(
    { exists: true, status: "running", healthStatus: null },
    { reachable: true, httpStatus: 200 }
  );

  assert.equal(verdict.outcome, HEALTH_OUTCOME.VERIFIED);
});

test("running with no healthcheck and no app answer is explicitly unproven, not healthy", () => {
  const verdict = classifyHealthSnapshot(
    { exists: true, status: "running", healthStatus: null },
    { reachable: false, httpStatus: null, error: "connect ECONNREFUSED" }
  );

  assert.equal(verdict.outcome, "running-unverified");
  assert.match(verdict.reason, /did not respond/);
});

test("verifyServiceHealth polls until the healthcheck turns healthy", async () => {
  const states = [
    { exists: false, status: null, healthStatus: null },
    { exists: true, status: "running", healthStatus: "starting" },
    { exists: true, status: "running", healthStatus: "healthy" }
  ];
  let call = 0;

  const result = await verifyServiceHealth({}, service, {
    inspectImpl: async () => states[Math.min(call++, states.length - 1)],
    probeImpl: async () => ({ reachable: false, httpStatus: null }),
    sleepImpl: async () => {},
    intervalMs: 0,
    timeoutMs: 1_000,
    nowImpl: () => 0
  });

  assert.equal(result.outcome, HEALTH_OUTCOME.VERIFIED);
  assert.equal(result.attempts, 3);
});

test("verifyServiceHealth resolves to unverified when a running container never proves itself", async () => {
  let clock = 0;

  const result = await verifyServiceHealth({}, service, {
    inspectImpl: async () => ({ exists: true, status: "running", healthStatus: null }),
    probeImpl: async () => ({ reachable: false, httpStatus: null, error: "timeout" }),
    sleepImpl: async () => {
      clock += 1_000;
    },
    intervalMs: 0,
    timeoutMs: 2_000,
    nowImpl: () => clock
  });

  assert.equal(result.outcome, HEALTH_OUTCOME.UNVERIFIED);
});

test("verifyServiceHealth fails when a container never appears before the deadline", async () => {
  let clock = 0;

  const result = await verifyServiceHealth({}, service, {
    inspectImpl: async () => ({ exists: false, status: null, healthStatus: null }),
    probeImpl: async () => null,
    sleepImpl: async () => {
      clock += 1_000;
    },
    intervalMs: 0,
    timeoutMs: 2_000,
    nowImpl: () => clock
  });

  assert.equal(result.outcome, HEALTH_OUTCOME.FAILED);
  assert.match(result.reason, /Timed out/);
});

test("verifyServiceHealth does not probe a container that is not running", async () => {
  let probes = 0;

  await verifyServiceHealth({}, service, {
    inspectImpl: async () => ({ exists: true, status: "exited", healthStatus: null }),
    probeImpl: async () => {
      probes += 1;
      return { reachable: true, httpStatus: 200 };
    },
    sleepImpl: async () => {},
    timeoutMs: 1_000,
    nowImpl: () => 0
  });

  assert.equal(probes, 0);
});

test("a loopback app URL is not probed, since localhost is the controller not the host", () => {
  assert.equal(isProbeableAppUrl("http://localhost:7878"), false);
  assert.equal(isProbeableAppUrl("http://127.0.0.1:7878"), false);
  assert.equal(isProbeableAppUrl("http://0.0.0.0:7878"), false);
  assert.equal(isProbeableAppUrl(""), false);
  assert.equal(isProbeableAppUrl("http://198.51.100.2:7878"), true);
  assert.equal(isProbeableAppUrl("http://nas.local:7878"), true);
});

test("an unprobeable app URL reports honestly instead of claiming the app did not respond", async () => {
  let probes = 0;
  let clock = 0;

  const result = await verifyServiceHealth({}, { containerName: "radarr", appUrl: "http://localhost:7878", healthStatuses: [200] }, {
    inspectImpl: async () => ({ exists: true, status: "running", healthStatus: null }),
    probeImpl: async () => {
      probes += 1;
      return { reachable: false, httpStatus: null, error: "fetch failed" };
    },
    sleepImpl: async () => {
      clock += 1_000;
    },
    intervalMs: 0,
    timeoutMs: 2_000,
    nowImpl: () => clock
  });

  assert.equal(probes, 0);
  assert.equal(result.outcome, HEALTH_OUTCOME.UNVERIFIED);
  assert.match(result.reason, /not reachable from the controller/);
  assert.doesNotMatch(result.reason, /did not respond/);
});
