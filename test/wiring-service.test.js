import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";

import { WiringService } from "../src/lib/app-services/wiring-service.js";
import { createLogger } from "../src/lib/logger.js";
import { normalizeSettings } from "../src/lib/store.js";

const noop = () => {};
const silentLogger = createLogger({
  level: "error",
  filePath: path.join(tmpdir(), "keelarr-test.log"),
  consoleImpl: { debug: noop, info: noop, warn: noop, error: noop, log: noop }
});

const RADARR_KEY = "0123456789abcdef0123456789abcdef";
const SAB_KEY = "fedcba9876543210fedcba9876543210";

function buildSettings(selectedServiceIds = ["radarr", "sabnzbd"]) {
  return normalizeSettings({
    initialized: true,
    hostUrl: "http://198.51.100.2",
    stackRoot: "/share/Container/docker",
    configRoot: "/share/Container",
    mediaRoot: "/share/Media",
    downloadsRoot: "/share/Media/Downloads",
    selectedServiceIds
  });
}

/** Shapes below mirror real `docker inspect` output from the QNAP stack. */
const LONG_AGO = "2026-08-01T00:00:00.000Z";
const NOW = Date.parse("2026-08-05T12:00:00.000Z");

function hostNetInspect(name, port, startedAt = LONG_AGO) {
  return {
    Name: `/${name}`,
    State: { Running: true, StartedAt: startedAt },
    HostConfig: { NetworkMode: "host" },
    Config: { ExposedPorts: { [`${port}/tcp`]: {} } },
    NetworkSettings: { Networks: { host: { IPAddress: "" } }, Ports: {} },
    Mounts: [{ Source: "/share/Media", Destination: "/Media" }]
  };
}

function macvlanInspect(name, port, address) {
  return {
    Name: `/${name}`,
    State: { Running: true, StartedAt: LONG_AGO },
    HostConfig: { NetworkMode: "qnet-static-eth1" },
    Config: { ExposedPorts: { [`${port}/tcp`]: {} } },
    NetworkSettings: { Networks: { "qnet-static-eth1": { IPAddress: address } }, Ports: {} },
    Mounts: [{ Source: "/share/Media", Destination: "/Media" }]
  };
}

function controllerInspect() {
  return {
    Name: "/keelarr",
    State: { Running: true, StartedAt: LONG_AGO },
    HostConfig: { NetworkMode: "deploy_default" },
    Config: { ExposedPorts: { "4687/tcp": {} } },
    NetworkSettings: {
      Networks: { deploy_default: { IPAddress: "172.29.0.2" } },
      Ports: { "4687/tcp": [{ HostIp: "0.0.0.0", HostPort: "4687" }] }
    },
    Mounts: []
  };
}

const DRIVERS = new Map([
  ["host", "host"],
  ["qnet-static-eth1", "qnet"],
  ["deploy_default", "bridge"]
]);

function sabClient(host = "198.51.100.10", port = 8080) {
  return {
    id: 1,
    name: "SABnzbd",
    implementation: "Sabnzbd",
    enable: true,
    fields: [
      { name: "host", value: host },
      { name: "port", value: port },
      // A real Arr masks this as "********". Seeding the actual key makes the
      // fixture hostile on purpose: if the projection is ever loosened to a
      // spread, the leak test below fails rather than passing by the remote
      // app's good manners.
      { name: "apiKey", value: SAB_KEY },
      { name: "movieCategory", value: "movies" }
    ]
  };
}

function createService(overrides = {}) {
  const calls = [];
  const settings = overrides.settings || buildSettings();
  const inspects = overrides.inspects || [
    hostNetInspect("radarr", 7878),
    macvlanInspect("sabnzbd", 8080, "198.51.100.10"),
    controllerInspect()
  ];

  const service = new WiringService({
    logger: silentLogger,
    nowImpl: () => overrides.now || NOW,
    loadSettingsImpl: async () => settings,
    inspectContainersImpl: async () => inspects,
    inspectNetworkDriversImpl: async () => overrides.drivers || DRIVERS,
    readApiKeyImpl: async (_settings, target) => {
      calls.push(`key:${target.id}`);
      return (
        overrides.keys?.[target.id] || {
          key: target.id === "sabnzbd" ? SAB_KEY : RADARR_KEY,
          descriptor: { found: true, state: "found", source: "/config/config.xml", fingerprint: "aabbccdd" },
          downloadSettings:
            target.id === "sabnzbd"
              ? { completeDir: "/Media/Downloads/complete", downloadDir: "/Media/Downloads/incomplete", hostWhitelist: ["198.51.100.10"] }
              : null
        }
      );
    },
    arrApiImpl: {
      systemStatus: async (serviceId) => {
        calls.push(`status:${serviceId}`);
        return overrides.status?.[serviceId] || { ok: true, data: { version: "6.3.0" }, error: null };
      },
      listDownloadClients: async (serviceId) => {
        calls.push(`clients:${serviceId}`);
        return { ok: true, data: overrides.downloadClients ?? [sabClient()], error: null };
      },
      listRootFolders: async () => ({ ok: true, data: overrides.rootFolders ?? [{ path: "/Media/Movies" }], error: null }),
      listApplications: async () => ({ ok: true, data: overrides.applications ?? [], error: null }),
      listIndexerProxies: async () => ({ ok: true, data: overrides.indexerProxies ?? [], error: null }),
      testAllDownloadClients: async () => ({ ok: true, data: [{ id: 1, isValid: true, validationFailures: [] }], error: null }),
      testAllApplications: async () => ({ ok: true, data: [], error: null })
    }
  });

  return { service, calls, settings };
}

test("an already-wired stack reports ready without proposing anything", async () => {
  const { service } = createService();
  const result = await service.describeWiring();

  assert.equal(result.readiness, "ready");
  assert.equal(result.summary.absent, 0);
  assert.equal(result.summary.drift, 0);
  assert.match(result.readinessMessage, /Stack ready/);
});

test("the download client link resolves SABnzbd to its own address, not the host", async () => {
  const { service } = createService();
  const result = await service.describeWiring();
  const link = result.links.find((entry) => entry.kind === "download-client");

  assert.equal(link.state, "correct");
  assert.equal(link.address.baseUrl, "http://198.51.100.10:8080");
  assert.ok(!link.address.baseUrl.includes("198.51.100.2"));
});

test("a download client at a stale address is reported as drift and left alone", async () => {
  const { service } = createService({ downloadClients: [sabClient("198.51.100.99")] });
  const result = await service.describeWiring();
  const link = result.links.find((entry) => entry.kind === "download-client");

  assert.equal(link.state, "drift");
  assert.deepEqual(link.changes, [{ field: "host", from: "198.51.100.99", to: "198.51.100.10" }]);
  assert.equal(result.readiness, "incomplete");
});

test("two mismatched clients are ambiguous rather than resolved by guessing", async () => {
  const { service } = createService({
    downloadClients: [sabClient("198.51.100.98"), { ...sabClient("198.51.100.99"), id: 2 }]
  });
  const result = await service.describeWiring();

  assert.equal(result.links.find((entry) => entry.kind === "download-client").state, "ambiguous");
  assert.equal(result.summary.ambiguous, 1);
});

test("an app whose key has not been written yet reports pending, not missing", async () => {
  const { service } = createService({
    keys: {
      radarr: {
        key: null,
        descriptor: { found: false, state: "pending", source: "/config/config.xml", reason: "not written yet" },
        downloadSettings: null
      }
    }
  });
  const result = await service.describeWiring();

  // A container that has been up for four seconds is young, not broken.
  assert.equal(result.readiness, "pending");
  assert.match(result.readinessMessage, /Check again in a few seconds/);
});

test("an unreachable app degrades one row instead of failing the whole check", async () => {
  const { service } = createService({
    status: { radarr: { ok: false, data: null, error: "The app rejected the API key." } }
  });
  const result = await service.describeWiring();

  assert.equal(result.ok, true);
  assert.equal(result.links.find((entry) => entry.kind === "download-client").state, "unknown");
  assert.match(result.links[0].reason, /rejected the API key/);
});

test("an app that started seconds ago and is not answering yet reports pending, not a fault", async () => {
  // Observed on a real install: the Arr writes config.xml within a second but
  // does not accept requests for a while after. Reporting that as unreadable
  // makes every fresh install flash red before it settles.
  const { service } = createService({
    inspects: [
      hostNetInspect("radarr", 7878, new Date(NOW - 10_000).toISOString()),
      macvlanInspect("sabnzbd", 8080, "198.51.100.10"),
      controllerInspect()
    ],
    status: { radarr: { ok: false, data: null, error: "No answer within 10s." } }
  });
  const result = await service.describeWiring();

  assert.equal(result.links.find((entry) => entry.kind === "download-client").state, "pending");
  assert.equal(result.readiness, "pending");
});

test("an app that has been up for days and is not answering is a genuine fault", async () => {
  const { service } = createService({
    status: { radarr: { ok: false, data: null, error: "No answer within 10s." } }
  });
  const result = await service.describeWiring();

  assert.equal(result.links.find((entry) => entry.kind === "download-client").state, "unknown");
  assert.equal(result.readiness, "incomplete");
});

test("a blocked link still produces a successful check, because an obstacle is not a failure", async () => {
  // Both apps on separate bridge networks: this host cannot route between them.
  const bridge = (name, port, network) => ({
    Name: `/${name}`,
    State: { Running: true, StartedAt: LONG_AGO },
    HostConfig: { NetworkMode: network },
    Config: { ExposedPorts: { [`${port}/tcp`]: {} } },
    NetworkSettings: {
      Networks: { [network]: { IPAddress: "172.20.0.2" } },
      Ports: { [`${port}/tcp`]: [{ HostIp: "0.0.0.0", HostPort: String(port) }] }
    },
    Mounts: [{ Source: "/share/Media", Destination: "/Media" }]
  });

  // The controller shares Radarr's network, so it can read Radarr's config —
  // otherwise the honest verdict would be "unknown" rather than "blocked".
  const controllerOnRadarrNetwork = {
    ...controllerInspect(),
    HostConfig: { NetworkMode: "radarr_default" },
    NetworkSettings: { Networks: { radarr_default: { IPAddress: "172.20.0.9" } }, Ports: {} }
  };

  const { service } = createService({
    inspects: [
      bridge("radarr", 7878, "radarr_default"),
      bridge("sabnzbd", 8080, "sab_default"),
      controllerOnRadarrNetwork
    ],
    drivers: new Map([
      ["radarr_default", "bridge"],
      ["sab_default", "bridge"]
    ])
  });
  const result = await service.describeWiring();

  assert.equal(result.ok, true);
  assert.equal(result.readiness, "blocked");
  assert.match(result.readinessMessage, /cannot be made on this host's networking/);
});

test("no API key ever reaches the response", async () => {
  const { service } = createService({ downloadClients: [sabClient()] });
  const payload = JSON.stringify(await service.describeWiring());

  assert.ok(!payload.includes(RADARR_KEY), "the Arr's own key leaked");
  assert.ok(!payload.includes(SAB_KEY), "a key present on a fetched object leaked through the projection");
  // The durable assertion: catches a key arriving by a route nobody anticipated.
  assert.equal(payload.match(/\b[0-9a-f]{32}\b/), null);
});

test("root folders are reported from the container path, never the host media root", async () => {
  const { service } = createService();
  const result = await service.describeWiring();
  const folder = result.rootFolders.find((entry) => entry.serviceId === "radarr");

  assert.equal(folder.state, "correct");
  assert.equal(folder.expectedPath, "/Media/Movies");
  assert.ok(!folder.expectedPath.startsWith("/share"));
});

test("matching mounts mean no path mapping is proposed", async () => {
  const { service } = createService();
  const result = await service.describeWiring();

  assert.equal(result.pathMappings[0].state, "not-needed");
  assert.match(result.pathMappings[0].reason, /no mapping is required/);
});

test("Prowlarr links are reported as not applicable when it is not installed", async () => {
  const { service } = createService();
  const result = await service.describeWiring();
  const link = result.links.find((entry) => entry.kind === "indexer-app");

  assert.equal(link.state, "not-applicable");
  assert.match(link.reason, /not part of this stack/);
  // Not-applicable rows never drag the verdict away from ready.
  assert.equal(result.readiness, "ready");
});

test("a stack of one app is ready, not incomplete", async () => {
  // Nothing to link a single app to. Requiring at least one connection before
  // the stack could read as correct reported the smallest possible install as
  // "0 of 0 connections are configured: ." — a fault that does not exist.
  const { service } = createService({
    settings: buildSettings(["prowlarr"]),
    inspects: [hostNetInspect("prowlarr", 9696), controllerInspect()]
  });
  const result = await service.describeWiring();

  assert.equal(result.summary.total, 0);
  assert.equal(result.readiness, "ready");
  assert.doesNotMatch(result.readinessMessage, /0 of 0/);
});

test("one app that still needs a credential says so instead of reporting a fault", async () => {
  const { service } = createService({
    settings: buildSettings(["prowlarr"]),
    inspects: [hostNetInspect("prowlarr", 9696), controllerInspect()],
    indexerCount: 0
  });
  const result = await service.describeWiring();

  // Either verdict is honest here as long as it is not "incomplete", which
  // would be claiming Keelarr left connections unmade.
  assert.notEqual(result.readiness, "incomplete");
});

// --- a container that started seconds ago is not a fault ---

test("a service that has only just started is pending, not blocked", async () => {
  // Post-deploy wiring runs immediately after creating the containers. A link
  // to one that cannot answer yet must read as "not yet" so the job waits;
  // reading it as "blocked" made the job conclude there was nothing to do.
  const justNow = new Date(NOW - 3000).toISOString();
  const { service } = createService({
    inspects: [
      hostNetInspect("radarr", 7878),
      { ...macvlanInspect("sabnzbd", 8080, "198.51.100.10"), State: { Running: true, StartedAt: justNow } },
      controllerInspect()
    ],
    // No route between them, so the link cannot resolve either way.
    drivers: new Map([["host", "host"], ["deploy_default", "bridge"]])
  });

  const result = await service.describeWiring();
  const link = result.links.find((entry) => entry.kind === "download-client");

  assert.equal(link.state, "pending");
  assert.match(link.reason, /only just started/);
  // Pending is what makes the apply job wait rather than declare victory.
  assert.equal(result.readiness, "pending");
});

test("a service that started long ago and cannot be reached is blocked, not pending", async () => {
  // The distinction has to hold in both directions, or the job waits forever
  // on something that will never answer.
  const { service } = createService({
    inspects: [hostNetInspect("radarr", 7878), macvlanInspect("sabnzbd", 8080, "198.51.100.10"), controllerInspect()],
    drivers: new Map([["host", "host"], ["deploy_default", "bridge"]])
  });

  const result = await service.describeWiring();
  const link = result.links.find((entry) => entry.kind === "download-client");

  assert.notEqual(link.state, "pending");
  assert.doesNotMatch(String(link.reason || ""), /only just started/);
});

// --- configuration left behind by a removed app ---

test("a proxy pointing at a removed FlareSolverr is reported, not hidden", async () => {
  // Removing FlareSolverr leaves Prowlarr holding a proxy addressed to a host
  // that no longer resolves, and every indexer tagged to use it fails. The
  // check skipped this entirely, because the link kind is only considered when
  // FlareSolverr is part of the stack.
  const { service } = createService({
    settings: buildSettings(["prowlarr", "radarr"]),
    inspects: [hostNetInspect("radarr", 7878), hostNetInspect("prowlarr", 9696), controllerInspect()],
    indexerProxies: [
      { id: 1, name: "FlareSolverr", implementation: "FlareSolverr", fields: [{ name: "host", value: "http://flaresolverr:8191" }] }
    ]
  });

  const report = await service.describeWiring();

  const proxy = report.orphans.find((entry) => entry.kind === "indexer-proxy");
  assert.equal(proxy.serviceId, "prowlarr");
  assert.match(proxy.summary, /FlareSolverr is not part of this stack/);
  assert.match(proxy.consequence, /tagged to use it will fail/);

  // The same rule catches a download client left behind: this stack has Radarr
  // still pointing at a SABnzbd that is not part of it.
  const client = report.orphans.find((entry) => entry.kind === "download-client");
  assert.equal(client.serviceId, "radarr");
  assert.match(client.summary, /not part of this stack/);
});

test("a stack with nothing left over reports none", async () => {
  const { service } = createService();
  const report = await service.describeWiring();

  assert.deepEqual(report.orphans, []);
});

test("the verdict admits leftovers rather than reading as simply ready", async () => {
  // Reporting "Stack ready" while an app holds a broken connection is the same
  // dishonesty as a job succeeding with nothing done.
  const { service } = createService({
    settings: buildSettings(["prowlarr", "radarr"]),
    inspects: [hostNetInspect("radarr", 7878), hostNetInspect("prowlarr", 9696), controllerInspect()],
    indexerProxies: [
      { id: 1, name: "FlareSolverr", implementation: "FlareSolverr", fields: [{ name: "host", value: "http://flaresolverr:8191" }] }
    ]
  });

  const report = await service.describeWiring();

  assert.match(report.readinessMessage, /leftover/i);
});
