import test from "node:test";
import assert from "node:assert/strict";

import {
  ENDPOINT_KIND,
  LINK_STRATEGY,
  buildEndpoint,
  resolveLink
} from "../src/lib/wiring/topology.js";

const HOST_ADDRESS = "198.51.100.2";

/**
 * The fixtures below mirror real `docker inspect` output from the QNAP stack
 * this feature was built against, because the failure modes it guards are all
 * consequences of that host's real topology rather than of anything invented.
 */
function inspectFor({ running = true, networkMode, networks = {}, exposed = [], ports = {} }) {
  return {
    State: { Running: running },
    HostConfig: { NetworkMode: networkMode },
    Config: { ExposedPorts: Object.fromEntries(exposed.map((port) => [`${port}/tcp`, {}])) },
    NetworkSettings: { Networks: networks, Ports: ports }
  };
}

const DRIVERS = new Map([
  ["host", "host"],
  ["qnet-static-eth1", "qnet"],
  ["ombi_default", "bridge"],
  ["deploy_default", "bridge"],
  ["bridge", "bridge"],
  ["stackarr", "bridge"]
]);

// --- imported stack: every service landed on a different kind of network ---

function radarr() {
  return buildEndpoint({
    serviceId: "radarr",
    name: "Radarr",
    containerName: "radarr",
    fallbackPort: 7878,
    networkDrivers: DRIVERS,
    inspect: inspectFor({ networkMode: "host", networks: { host: { IPAddress: "" } }, exposed: [7878] })
  });
}

function sabnzbd() {
  return buildEndpoint({
    serviceId: "sabnzbd",
    name: "SABnzbd",
    containerName: "sabnzbd",
    fallbackPort: 8080,
    networkDrivers: DRIVERS,
    inspect: inspectFor({
      networkMode: "qnet-static-eth1",
      networks: { "qnet-static-eth1": { IPAddress: "198.51.100.10" } },
      exposed: [8080]
    })
  });
}

function ombi() {
  return buildEndpoint({
    serviceId: "ombi",
    name: "Ombi",
    containerName: "ombi",
    fallbackPort: 3579,
    networkDrivers: DRIVERS,
    inspect: inspectFor({
      networkMode: "ombi_default",
      networks: { ombi_default: { IPAddress: "172.29.16.2" } },
      exposed: [3579],
      ports: { "3579/tcp": [{ HostIp: "0.0.0.0", HostPort: "3579" }] }
    })
  });
}

function controller() {
  return buildEndpoint({
    serviceId: "stackarr",
    name: "Stackarr",
    containerName: "stackarr",
    fallbackPort: 4687,
    networkDrivers: DRIVERS,
    inspect: inspectFor({
      networkMode: "deploy_default",
      networks: { deploy_default: { IPAddress: "172.29.0.2" } },
      exposed: [4687],
      ports: { "4687/tcp": [{ HostIp: "0.0.0.0", HostPort: "4687" }] }
    })
  });
}

// --- fresh catalog stack: everything on the one shared network ---

function catalogService(serviceId, name, port) {
  return buildEndpoint({
    serviceId,
    name,
    containerName: serviceId,
    fallbackPort: port,
    networkDrivers: DRIVERS,
    inspect: inspectFor({
      networkMode: "stackarr",
      networks: { stackarr: { IPAddress: `172.30.0.${port % 200}` } },
      exposed: [port],
      ports: { [`${port}/tcp`]: [{ HostIp: "0.0.0.0", HostPort: String(port) }] }
    })
  });
}

test("a host-networked container is classified as host, not bridge", () => {
  assert.equal(radarr().kind, ENDPOINT_KIND.HOST);
});

test("QNAP's qnet driver is recognized as addressable, not as an ordinary bridge", () => {
  // Container Station names its macvlan driver `qnet`. Classifying by the
  // network name prefix, or by the upstream `macvlan` driver name alone, puts
  // SABnzbd in the bridge branch and sends callers to the host address.
  assert.equal(sabnzbd().kind, ENDPOINT_KIND.MACVLAN);
});

test("SABnzbd resolves to its own address and never to the host address", () => {
  const link = resolveLink(radarr(), sabnzbd(), { hostAddress: HOST_ADDRESS });

  assert.equal(link.ok, true);
  assert.equal(link.baseUrl, "http://198.51.100.10:8080");
  assert.equal(link.strategy, LINK_STRATEGY.MACVLAN_IP);
  // On a QNAP, 198.51.100.2:8080 is the NAS administration interface. It answers
  // 200, so a download client pointed there looks configured and never works.
  assert.ok(!link.baseUrl.includes(HOST_ADDRESS));
});

test("a host-networked target is addressed at the host address", () => {
  const link = resolveLink(sabnzbd(), radarr(), { hostAddress: HOST_ADDRESS });

  assert.equal(link.baseUrl, "http://198.51.100.2:7878");
  assert.equal(link.strategy, LINK_STRATEGY.HOST_NETWORK);
});

test("the controller reaches a host-networked app even though it is a bridge container", () => {
  const link = resolveLink(controller(), radarr(), { hostAddress: HOST_ADDRESS });

  assert.equal(link.ok, true);
  assert.equal(link.baseUrl, "http://198.51.100.2:7878");
});

test("two containers on separate bridge networks produce a blocked link, not a URL", () => {
  const link = resolveLink(controller(), ombi(), { hostAddress: HOST_ADDRESS });

  assert.equal(link.ok, false);
  assert.equal(link.blocked, true);
  assert.equal(link.baseUrl, null);
  assert.match(link.reason, /separate Docker bridge networks/);
});

test("a host-networked source can still reach a published bridge port", () => {
  const link = resolveLink(radarr(), ombi(), { hostAddress: HOST_ADDRESS });

  assert.equal(link.ok, true);
  assert.equal(link.baseUrl, "http://198.51.100.2:3579");
  assert.equal(link.strategy, LINK_STRATEGY.HOST_PUBLISHED);
});

test("a shared user-defined network is preferred over the host address", () => {
  const prowlarr = catalogService("prowlarr", "Prowlarr", 9696);
  const lidarr = catalogService("lidarr", "Lidarr", 8686);
  const link = resolveLink(prowlarr, lidarr, { hostAddress: HOST_ADDRESS });

  assert.equal(link.baseUrl, "http://lidarr:8686");
  assert.equal(link.strategy, LINK_STRATEGY.SHARED_NETWORK);
});

test("a fresh catalog stack has no blocked links at all", () => {
  const services = [
    catalogService("prowlarr", "Prowlarr", 9696),
    catalogService("radarr", "Radarr", 7878),
    catalogService("sonarr", "Sonarr", 8989),
    catalogService("sabnzbd", "SABnzbd", 8080)
  ];

  for (const source of services) {
    for (const target of services) {
      if (source === target) {
        continue;
      }

      const link = resolveLink(source, target, { hostAddress: HOST_ADDRESS });
      assert.equal(link.ok, true, `${source.serviceId} -> ${target.serviceId}: ${link.reason}`);
      assert.equal(link.strategy, LINK_STRATEGY.SHARED_NETWORK);
    }
  }
});

test("the default bridge is addressed by IP, because it carries no DNS", () => {
  const onDefaultBridge = (serviceId, port) =>
    buildEndpoint({
      serviceId,
      name: serviceId,
      containerName: serviceId,
      fallbackPort: port,
      networkDrivers: DRIVERS,
      inspect: inspectFor({
        networkMode: "default",
        networks: { bridge: { IPAddress: `172.17.0.${port % 200}` } },
        exposed: [port],
        ports: { [`${port}/tcp`]: [{ HostIp: "0.0.0.0", HostPort: String(port) }] }
      })
    });

  const link = resolveLink(onDefaultBridge("radarr", 7878), onDefaultBridge("tautulli", 8181), {
    hostAddress: HOST_ADDRESS
  });

  // Sharing the default bridge is a real route, so it is used — but by address.
  // `http://tautulli:8181` would resolve to nothing, since only user-defined
  // networks carry Docker's embedded DNS.
  assert.equal(link.ok, true);
  assert.equal(link.strategy, LINK_STRATEGY.SHARED_BRIDGE_IP);
  assert.ok(!link.baseUrl.includes("tautulli"), "the container name must never be used on the default bridge");
  assert.match(link.baseUrl, /^http:\/\/172\.17\.0\.\d+:8181$/);
});

test("a remapped published port is addressed by its host port, not the container port", () => {
  const remapped = buildEndpoint({
    serviceId: "ombi",
    name: "Ombi",
    containerName: "ombi",
    fallbackPort: 3579,
    networkDrivers: DRIVERS,
    inspect: inspectFor({
      networkMode: "ombi_default",
      networks: { ombi_default: { IPAddress: "172.29.16.2" } },
      exposed: [3579],
      ports: { "3579/tcp": [{ HostIp: "0.0.0.0", HostPort: "13579" }] }
    })
  });

  assert.equal(resolveLink(radarr(), remapped, { hostAddress: HOST_ADDRESS }).baseUrl, "http://198.51.100.2:13579");
});

test("a stopped container is reported as unreachable rather than given an address", () => {
  const stopped = buildEndpoint({
    serviceId: "prowlarr",
    name: "Prowlarr",
    containerName: "prowlarr",
    fallbackPort: 9696,
    networkDrivers: DRIVERS,
    inspect: inspectFor({ running: false, networkMode: "stackarr", networks: {}, exposed: [9696] })
  });

  const link = resolveLink(radarr(), stopped, { hostAddress: HOST_ADDRESS });

  assert.equal(link.blocked, true);
  assert.match(link.reason, /not running/);
});

test("an unknown network driver blocks rather than guessing the host address", () => {
  const vendor = buildEndpoint({
    serviceId: "sabnzbd",
    name: "SABnzbd",
    containerName: "sabnzbd",
    fallbackPort: 8080,
    networkDrivers: new Map([["synology-lan", "some-vendor-driver"]]),
    inspect: inspectFor({
      networkMode: "synology-lan",
      networks: { "synology-lan": { IPAddress: "198.51.100.110" } },
      exposed: [8080]
    })
  });

  const link = resolveLink(radarr(), vendor, { hostAddress: HOST_ADDRESS });

  assert.equal(link.blocked, true);
  assert.ok(!String(link.baseUrl).includes(HOST_ADDRESS));
});
