import test from "node:test";
import assert from "node:assert/strict";

import { HEALTH_OUTCOME, classifyHealthSnapshot, clearProbeCache, isProbeableAppUrl, probeAppUrl, verifyServiceHealth } from "../src/lib/health.js";

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

test("probe results are cached so a refresh does not re-pay the timeout", async () => {
  clearProbeCache();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return { status: 200 };
  };

  const svc = { appUrl: "http://198.51.100.2:7878", healthStatuses: [200] };

  try {
    await probeAppUrl(svc);
    await probeAppUrl(svc);
    await probeAppUrl(svc);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    clearProbeCache();
  }
});

test("a failing probe backs off harder than a succeeding one", async () => {
  clearProbeCache();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("timed out");
  };

  const svc = { appUrl: "http://198.51.100.2:6767", healthStatuses: [200] };

  try {
    let clock = 0;
    await probeAppUrl(svc, { nowImpl: () => clock });
    // Still inside the success TTL but well inside the longer failure TTL.
    clock = 30_000;
    await probeAppUrl(svc, { nowImpl: () => clock });
    assert.equal(calls, 1, "a structural failure should not be re-probed every refresh");

    clock = 120_000;
    await probeAppUrl(svc, { nowImpl: () => clock });
    assert.equal(calls, 2, "it must eventually retry in case the app came back");
  } finally {
    globalThis.fetch = originalFetch;
    clearProbeCache();
  }
});

// --- slow starts are not deaths -------------------------------------------------

/**
 * The Trailarr case: the app answers at about 90s on a NAS because it updates
 * bundled tools and migrates its database at boot, while its image declares a
 * start_period of ten seconds. Calling that failed is what triggers a revert,
 * and an image revert is what strands the app on a schema it cannot read.
 */
test("a container still starting at the deadline is given a bounded grace to finish", async () => {
  let clock = 0;
  const states = [
    { exists: true, status: "running", healthStatus: "starting" },
    { exists: true, status: "running", healthStatus: "starting" },
    { exists: true, status: "running", healthStatus: "healthy" }
  ];
  let call = 0;

  const result = await verifyServiceHealth({}, service, {
    inspectImpl: async () => states[Math.min(call++, states.length - 1)],
    probeImpl: async () => ({ reachable: false, httpStatus: null }),
    sleepImpl: async () => {
      clock += 40_000;
    },
    intervalMs: 0,
    timeoutMs: 60_000,
    startingGraceMs: 120_000,
    nowImpl: () => clock
  });

  assert.equal(result.outcome, HEALTH_OUTCOME.VERIFIED, "it came up past the deadline, inside the grace");
  assert.equal(result.attempts, 3);
});

test("a container still starting after the grace is unverified, not failed", async () => {
  let clock = 0;

  const result = await verifyServiceHealth({}, service, {
    inspectImpl: async () => ({ exists: true, status: "running", healthStatus: "starting" }),
    probeImpl: async () => ({ reachable: false, httpStatus: null }),
    sleepImpl: async () => {
      clock += 30_000;
    },
    intervalMs: 0,
    timeoutMs: 60_000,
    startingGraceMs: 60_000,
    nowImpl: () => clock
  });

  // `failed` is the outcome that triggers an auto-revert. A healthcheck that
  // never got past `starting` is not evidence the app is down, so it must not
  // be the thing that sends a stateful app back to an older image.
  assert.equal(result.outcome, HEALTH_OUTCOME.UNVERIFIED);
  assert.match(result.reason, /Still starting/);
});

test("the grace is not extended to a healthcheck that is actively failing", async () => {
  let clock = 0;

  const result = await verifyServiceHealth({}, service, {
    inspectImpl: async () => ({ exists: true, status: "running", healthStatus: "unhealthy" }),
    probeImpl: async () => ({ reachable: false, httpStatus: null }),
    sleepImpl: async () => {
      clock += 30_000;
    },
    intervalMs: 0,
    timeoutMs: 60_000,
    startingGraceMs: 600_000,
    nowImpl: () => clock
  });

  // "unhealthy" is the container's own check reporting failure, not progress.
  assert.equal(result.outcome, HEALTH_OUTCOME.FAILED);
  assert.match(result.reason, /Timed out after 60000ms/);
});

test("a container in a restart loop is not given the starting grace", async () => {
  let clock = 0;
  let polls = 0;

  const result = await verifyServiceHealth({}, service, {
    // A crash loop: Docker reports `restarting`, and the healthcheck resets to
    // `starting` on every attempt.
    inspectImpl: async () => {
      polls += 1;
      return { exists: true, status: "restarting", healthStatus: "starting" };
    },
    probeImpl: async () => null,
    sleepImpl: async () => {
      clock += 30_000;
    },
    intervalMs: 0,
    timeoutMs: 60_000,
    startingGraceMs: 600_000,
    nowImpl: () => clock
  });

  // `restarting` is not in DEAD_STATUSES, so without the status check this took
  // the grace and then resolved to unverified — which callers read as "came up"
  // and record as current. A crash-looping upgrade must reach the revert path.
  assert.equal(result.outcome, HEALTH_OUTCOME.FAILED);
  assert.match(result.reason, /Timed out after 60000ms/);
  assert.ok(clock < 600_000, `it gave up at the deadline, not after the grace (polled ${polls} times)`);
});
