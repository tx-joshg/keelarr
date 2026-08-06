import test from "node:test";
import assert from "node:assert/strict";

import { buildDashboardState } from "../src/lib/status.js";
import { normalizeSettings } from "../src/lib/store.js";
import { clearControllerEndpointCache, clearNetworkDriverCache } from "../src/lib/wiring/topology.js";

function settings() {
  return normalizeSettings({
    initialized: true,
    hostUrl: "http://198.51.100.2",
    stackRoot: "/share/Container/docker",
    configRoot: "/share/Container",
    mediaRoot: "/share/Media",
    selectedServiceIds: ["sabnzbd", "radarr", "prowlarr"]
  });
}

/** Mirrors the QNAP stack: macvlan, host networking, and a shared bridge. */
const INVENTORY = [
  {
    recognized: true,
    serviceId: "sabnzbd",
    containerName: "sabnzbd",
    status: "running",
    networkMode: "qnet-static-eth1",
    networks: [{ name: "qnet-static-eth1", address: "198.51.100.10" }],
    ports: []
  },
  {
    recognized: true,
    serviceId: "radarr",
    containerName: "radarr",
    status: "running",
    networkMode: "host",
    networks: [{ name: "host", address: null }],
    ports: []
  },
  {
    recognized: true,
    serviceId: "prowlarr",
    containerName: "prowlarr",
    status: "running",
    networkMode: "stackarr",
    networks: [{ name: "stackarr", address: "172.29.12.3" }],
    ports: [{ containerPort: "9696/tcp", hostIp: "0.0.0.0", hostPort: "9696" }]
  }
];

const DRIVERS = new Map([
  ["qnet-static-eth1", "qnet"],
  ["host", "host"],
  ["stackarr", "bridge"],
  ["deploy_default", "bridge"]
]);

const CONTROLLER_INSPECT = {
  Name: "/stackarr",
  State: { Running: true, StartedAt: "2026-08-01T00:00:00.000Z" },
  HostConfig: { NetworkMode: "stackarr" },
  Config: { ExposedPorts: { "4687/tcp": {} } },
  NetworkSettings: { Networks: { stackarr: { IPAddress: "172.29.12.2" } }, Ports: {} },
  Mounts: []
};

async function buildState(t) {
  // Both caches are module-level and would otherwise leak between tests.
  clearControllerEndpointCache();
  clearNetworkDriverCache();
  t.after(() => {
    clearControllerEndpointCache();
    clearNetworkDriverCache();
  });

  const probed = [];

  const state = await buildDashboardState(settings(), {
    readActivityImpl: async () => [],
    readUpdateStateImpl: async () => ({}),
    scanDockerInventoryImpl: async () => ({ items: INVENTORY }),
    inspectContainersImpl: async () => [CONTROLLER_INSPECT],
    inspectNetworkDriversImpl: async () => DRIVERS,
    composePsImpl: async () => ({ ok: true, data: [] }),
    probeServiceImpl: async (service) => {
      probed.push(service.appUrl);
      return { reachable: true, latencyMs: 5, httpStatus: 200 };
    }
  });

  return { state, probed, of: (id) => state.services.find((entry) => entry.id === id) };
}

test("SABnzbd is probed at its own address, not the host's", async (t) => {
  const { probed, of } = await buildState(t);

  // The bug this replaces: http://198.51.100.2:8080 is the QNAP administration
  // interface, which answers 200. SABnzbd could be dead and still look healthy.
  assert.ok(probed.includes("http://198.51.100.10:8080"), `probed: ${probed.join(", ")}`);
  assert.ok(!probed.includes("http://198.51.100.2:8080"));
  assert.equal(of("sabnzbd").probe.url, "http://198.51.100.10:8080");
  assert.equal(of("sabnzbd").probe.strategy, "macvlan-ip");
});

test("the browser link for a macvlan app is its LAN address, which is clickable", async (t) => {
  const { of } = await buildState(t);

  assert.equal(of("sabnzbd").appUrl, "http://198.51.100.10:8080");
});

test("the controller probes a shared-network app by container name", async (t) => {
  const { of } = await buildState(t);

  assert.equal(of("prowlarr").probe.url, "http://prowlarr:9696");
  assert.equal(of("prowlarr").probe.strategy, "shared-network");
});

test("the browser link never uses a container name, which would not resolve", async (t) => {
  const { of } = await buildState(t);

  // Prowlarr resolves by name for the controller and by published port for a
  // person. Collapsing these into one value breaks whichever one loses.
  assert.equal(of("prowlarr").appUrl, "http://198.51.100.2:9696");
  assert.notEqual(of("prowlarr").appUrl, of("prowlarr").probe.url);
});

test("a host-networked app is reached at the host address from both positions", async (t) => {
  const { of } = await buildState(t);

  assert.equal(of("radarr").probe.url, "http://198.51.100.2:7878");
  assert.equal(of("radarr").appUrl, "http://198.51.100.2:7878");
});

test("an app the controller cannot reach is marked unchecked rather than probed anyway", async (t) => {
  clearControllerEndpointCache();
  clearNetworkDriverCache();
  t.after(() => {
    clearControllerEndpointCache();
    clearNetworkDriverCache();
  });

  const probed = [];
  const isolated = {
    ...CONTROLLER_INSPECT,
    HostConfig: { NetworkMode: "deploy_default" },
    NetworkSettings: { Networks: { deploy_default: { IPAddress: "172.20.0.2" } }, Ports: {} }
  };

  const state = await buildDashboardState(settings(), {
    readActivityImpl: async () => [],
    readUpdateStateImpl: async () => ({}),
    scanDockerInventoryImpl: async () => ({ items: INVENTORY }),
    inspectContainersImpl: async () => [isolated],
    inspectNetworkDriversImpl: async () => DRIVERS,
    composePsImpl: async () => ({ ok: true, data: [] }),
    probeServiceImpl: async (service) => {
      probed.push(service.appUrl);
      return { reachable: true, latencyMs: 5, httpStatus: 200 };
    }
  });

  const prowlarr = state.services.find((entry) => entry.id === "prowlarr");

  // Bridge to bridge-published does not route on this host. Probing the host
  // address anyway would spend a timeout to learn nothing, and the browser link
  // must still work even though the controller's check cannot.
  assert.equal(prowlarr.probe.checked, false);
  assert.equal(prowlarr.probe.url, null);
  assert.match(prowlarr.probe.reason, /separate Docker bridge networks/);
  assert.equal(prowlarr.appUrl, "http://198.51.100.2:9696");
  assert.ok(!probed.includes("http://198.51.100.2:9696"));
});
