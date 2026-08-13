import { runCommand } from "../command-runner.js";

/**
 * How a container is attached to the network, which is what decides the address
 * every other container must use to reach it.
 */
export const ENDPOINT_KIND = Object.freeze({
  /** network_mode: host — the container listens on the host's own address. */
  HOST: "host",
  /** macvlan/ipvlan — the container has its own address on the LAN. */
  MACVLAN: "macvlan",
  /** Any bridge network, with or without published ports. */
  BRIDGE: "bridge",
  /** network_mode: none, or the container is not running. */
  NONE: "none"
});

export const LINK_STRATEGY = Object.freeze({
  SHARED_NETWORK: "shared-network",
  SHARED_BRIDGE_IP: "shared-bridge-ip",
  MACVLAN_IP: "macvlan-ip",
  HOST_NETWORK: "host-network",
  HOST_PUBLISHED: "host-published"
});

/**
 * Docker's built-in bridge has no embedded DNS, so container names do not
 * resolve on it. Two containers sharing only this network are not linkable by
 * name, even though they technically share a network.
 */
const DEFAULT_BRIDGE_NETWORK = "bridge";

/**
 * Drivers that give a container its own address on the LAN and publish no ports
 * to the host. `qnet` is QNAP Container Station's macvlan equivalent — it does
 * not report itself as `macvlan`, so recognizing only the upstream driver names
 * would classify SABnzbd as an ordinary bridge container and send callers to the
 * host address instead of its own.
 *
 * A driver missing from this list resolves to a blocked link rather than a
 * guess, which is the safe direction to fail in.
 */
const ADDRESSABLE_DRIVERS = new Set(["macvlan", "ipvlan", "qnet"]);

/**
 * Reads the driver for each named network.
 *
 * The driver is the only trustworthy way to recognize macvlan: `docker inspect`
 * on a container reports the network's *name*, and QNAP happens to prefix its
 * macvlan networks with `qnet-`. Branching on that prefix works on one vendor's
 * NAS and silently mis-addresses every other host.
 */
/**
 * Cached rather than re-read on every dashboard refresh.
 *
 * Only names absent from the cache are looked up, so a network created after
 * startup is picked up the first time something sits on it — no expiry needed.
 * The one case this cannot notice is a network destroyed and recreated under
 * the same name with a different driver, which a controller restart resolves
 * and which no realistic workflow produces.
 */
const driverCache = new Map();

export function clearNetworkDriverCache() {
  driverCache.clear();
}

export async function inspectNetworkDrivers(settings, names, options = {}) {
  const requested = [...new Set((names || []).filter(Boolean))];
  const missing = requested.filter((name) => !driverCache.has(name));

  if (missing.length === 0) {
    return new Map(requested.map((name) => [name, driverCache.get(name)]));
  }

  let fresh = new Map();

  try {
    fresh = await readNetworkDrivers(settings, missing, options);
  } catch {
    // An unreadable driver leaves the network unclassified, which resolves to a
    // blocked link rather than a guessed address. Failing closed is right here.
    return new Map();
  }

  for (const [name, driver] of fresh) {
    driverCache.set(name, driver);
  }

  return new Map(
    requested.filter((name) => driverCache.has(name)).map((name) => [name, driverCache.get(name)])
  );
}

async function readNetworkDrivers(settings, names, options = {}) {
  const unique = [...new Set((names || []).filter(Boolean))];
  const drivers = new Map();

  if (unique.length === 0) {
    return drivers;
  }

  const result = await runCommand(
    settings.dockerBin,
    ["network", "inspect", ...unique, "--format", "{{.Name}}|{{.Driver}}"],
    options
  );

  if (!result.ok) {
    return drivers;
  }

  for (const line of String(result.stdout || "").split("\n")) {
    const [name, driver] = line.trim().split("|");

    if (name && driver) {
      drivers.set(name, driver);
    }
  }

  return drivers;
}

function readContainerPort(inspect, fallbackPort) {
  const exposed = Object.keys(inspect?.Config?.ExposedPorts || {})
    .filter((entry) => entry.endsWith("/tcp"))
    .map((entry) => Number.parseInt(entry, 10))
    .filter((entry) => Number.isFinite(entry));

  // Only trust the image when it names exactly one TCP port. Several ports means
  // guessing which one serves the API, and the catalog already knows.
  return exposed.length === 1 ? exposed[0] : fallbackPort;
}

function readPublished(inspect) {
  const published = [];

  for (const [containerPort, bindings] of Object.entries(inspect?.NetworkSettings?.Ports || {})) {
    for (const binding of bindings || []) {
      if (binding?.HostPort) {
        published.push({
          containerPort: Number.parseInt(containerPort, 10),
          hostIp: binding.HostIp && binding.HostIp !== "0.0.0.0" ? binding.HostIp : null,
          hostPort: Number.parseInt(binding.HostPort, 10)
        });
      }
    }
  }

  return published;
}

function classify(networkMode, networks, running) {
  if (!running) {
    return ENDPOINT_KIND.NONE;
  }

  if (networkMode === "host") {
    return ENDPOINT_KIND.HOST;
  }

  if (networkMode === "none") {
    return ENDPOINT_KIND.NONE;
  }

  return networks.some((network) => ADDRESSABLE_DRIVERS.has(network.driver))
    ? ENDPOINT_KIND.MACVLAN
    : ENDPOINT_KIND.BRIDGE;
}

/**
 * Flattens one `docker inspect` result into everything the resolver needs.
 * `networkDrivers` comes from `inspectNetworkDrivers`.
 */
export function buildEndpoint({
  serviceId,
  name,
  containerName,
  fallbackPort,
  inspect,
  networkDrivers = new Map()
}) {
  const running = inspect?.State?.Running === true;
  const networkMode = inspect?.HostConfig?.NetworkMode || "default";
  const networks = Object.entries(inspect?.NetworkSettings?.Networks || {}).map(([networkName, network]) => ({
    name: networkName,
    address: network?.IPAddress || null,
    driver: networkDrivers.get(networkName) || null
  }));

  return {
    serviceId,
    name: name || serviceId,
    containerName,
    running,
    startedAt: inspect?.State?.StartedAt || null,
    hasHealthcheck: Boolean(inspect?.Config?.Healthcheck?.Test?.length),
    // Kept so callers can ask what this container can actually see. For the
    // controller that is the difference between a real path and an invisible
    // one, whatever the host filesystem says.
    mounts: (inspect?.Mounts || []).map((mount) => ({ source: mount.Source, target: mount.Destination })),
    networkMode,
    kind: classify(networkMode, networks, running),
    containerPort: readContainerPort(inspect, fallbackPort),
    networks,
    published: readPublished(inspect)
  };
}

/**
 * How long after a container starts its app is still allowed to be silent.
 *
 * An Arr writes its config within a second or two but does not accept requests
 * for appreciably longer. Reporting that gap as a fault means every fresh
 * install shows red for its first few seconds.
 */
const STARTUP_GRACE_MS = 90_000;

export function isStillStarting(endpoint, now = Date.now()) {
  if (!endpoint?.startedAt) {
    return false;
  }

  const startedAt = Date.parse(endpoint.startedAt);
  return Number.isFinite(startedAt) && now - startedAt < STARTUP_GRACE_MS;
}

/**
 * Builds an endpoint from the shape the inventory scan already produces, so the
 * dashboard does not re-inspect every container it has just inspected.
 */
export function buildEndpointFromInventory({ serviceId, name, containerName, fallbackPort, item, networkDrivers = new Map() }) {
  const networks = (item?.networks || []).map((network) => ({
    name: network.name,
    address: network.address || null,
    driver: networkDrivers.get(network.name) || null
  }));
  const running = item?.status === "running";
  const networkMode = item?.networkMode || "default";

  return {
    serviceId,
    name: name || serviceId,
    containerName,
    running,
    startedAt: item?.startedAt || null,
    networkMode,
    kind: classify(networkMode, networks, running),
    containerPort: fallbackPort,
    networks,
    published: (item?.ports || [])
      .filter((entry) => entry.hostPort)
      .map((entry) => ({
        containerPort: Number.parseInt(entry.containerPort, 10),
        hostIp: entry.hostIp && entry.hostIp !== "0.0.0.0" ? entry.hostIp : null,
        hostPort: Number.parseInt(entry.hostPort, 10)
      }))
  };
}

/**
 * Stands in for the person's browser, which sits on the LAN rather than inside
 * Docker. It shares no container network, so container names never resolve for
 * it — but it can reach the host and anything with its own LAN address, which
 * is exactly how a host-networked source behaves.
 *
 * The dashboard needs this as a separate answer from the controller's: the URL
 * Keelarr uses to check an app and the URL you click to open it are two
 * different questions whenever the two sit in different places.
 */
export const LAN_CLIENT = Object.freeze({
  serviceId: "browser",
  name: "Your browser",
  containerName: null,
  running: true,
  kind: ENDPOINT_KIND.HOST,
  networkMode: "host",
  containerPort: null,
  networks: [],
  published: []
});

/** The controller is a source like any other, so it gets an endpoint too. */
export function buildControllerEndpoint(inspect, networkDrivers = new Map()) {
  return buildEndpoint({
    serviceId: "keelarr",
    name: "Keelarr",
    containerName: "keelarr",
    fallbackPort: null,
    inspect,
    networkDrivers
  });
}

let controllerEndpoint = null;

export function clearControllerEndpointCache() {
  controllerEndpoint = null;
}

/**
 * The controller's own network attachment, read once per process.
 *
 * It cannot change without the container being recreated, which restarts this
 * process — so caching it costs nothing in staleness and saves an inspect on
 * every dashboard refresh. Identified by hostname rather than by a hardcoded
 * container name, since inside a container the hostname is the container id.
 */
export async function loadControllerEndpoint(settings, { inspectContainersImpl, hostname, logger } = {}) {
  if (controllerEndpoint) {
    return controllerEndpoint;
  }

  const candidates = [hostname, "keelarr"].filter(Boolean);
  let inspect = null;

  try {
    inspect = (await inspectContainersImpl(settings, candidates, { logger }))[0] || null;
  } catch {
    inspect = null;
  }

  if (!inspect) {
    // Running outside a container, or under a name we cannot find. Treating it
    // as a LAN client is the honest fallback: it reaches published ports and
    // host networking, but resolves no container names.
    //
    // Deliberately not cached. A transient failure here would otherwise pin the
    // controller to the fallback for the life of the process, which is exactly
    // the over-broad addressing this function exists to replace.
    return { ...LAN_CLIENT, serviceId: "keelarr", name: "Keelarr" };
  }

  const drivers = await inspectNetworkDrivers(
    settings,
    Object.keys(inspect?.NetworkSettings?.Networks || {}),
    { logger }
  );
  controllerEndpoint = buildControllerEndpoint(inspect, drivers);
  return controllerEndpoint;
}

function sharedNamedNetwork(source, target) {
  const sourceNames = new Set(
    source.networks.filter((network) => network.name !== DEFAULT_BRIDGE_NETWORK).map((network) => network.name)
  );

  return target.networks.find(
    (network) => network.name !== DEFAULT_BRIDGE_NETWORK && sourceNames.has(network.name)
  ) || null;
}

function macvlanAddress(endpoint) {
  return endpoint.networks.find(
    (network) => ADDRESSABLE_DRIVERS.has(network.driver) && network.address
  )?.address || null;
}

function publishedBinding(endpoint) {
  return (
    endpoint.published.find((entry) => entry.containerPort === endpoint.containerPort) ||
    endpoint.published[0] ||
    null
  );
}

function blocked(reason) {
  return { ok: false, blocked: true, baseUrl: null, host: null, port: null, strategy: null, reason };
}

function linked(strategy, host, port, reason) {
  return { ok: true, blocked: false, baseUrl: `http://${host}:${port}`, host, port, strategy, reason };
}

/**
 * Works out the URL `source` must use to reach `target`.
 *
 * Rule order matters more than it looks. A macvlan container publishes no
 * ports, so any "fall back to the host address" branch placed ahead of rule 3
 * would compose the host address with the app's port and produce something that
 * answers — on a QNAP, `<host>:8080` is the NAS admin interface, which returns
 * 200 and looks exactly like success. Blocked links are reported, never guessed.
 */
export function resolveLink(source, target, { hostAddress } = {}) {
  if (!target.running) {
    return blocked(`${target.name} is not running, so nothing can reach it yet.`);
  }

  if (!target.containerPort) {
    return blocked(`${target.name} does not expose a port that Keelarr can identify.`);
  }

  if (target.kind === ENDPOINT_KIND.HOST) {
    if (!hostAddress) {
      return blocked(`${target.name} uses host networking, but no host address is configured for this stack.`);
    }

    return linked(
      LINK_STRATEGY.HOST_NETWORK,
      hostAddress,
      target.containerPort,
      `${target.name} uses host networking, so it answers on the host address at port ${target.containerPort}.`
    );
  }

  const shared = sharedNamedNetwork(source, target);

  if (shared) {
    return linked(
      LINK_STRATEGY.SHARED_NETWORK,
      target.containerName,
      target.containerPort,
      `${source.name} and ${target.name} share the ${shared.name} network, so ${target.name} resolves by container name.`
    );
  }

  // Docker's default bridge carries no DNS, so a shared membership there gives
  // no name to use — but it does give a route. The address is re-derived from a
  // live inspect on every check, so a bridge IP changing on recreate is fine.
  const sharedDefaultBridge = target.networks.find(
    (network) =>
      network.name === DEFAULT_BRIDGE_NETWORK &&
      network.address &&
      source.networks.some((entry) => entry.name === DEFAULT_BRIDGE_NETWORK)
  );

  if (sharedDefaultBridge) {
    return linked(
      LINK_STRATEGY.SHARED_BRIDGE_IP,
      sharedDefaultBridge.address,
      target.containerPort,
      `${source.name} and ${target.name} are both on Docker's default bridge, which has no DNS, so ${target.name} is reached at its address on that network.`
    );
  }

  if (target.kind === ENDPOINT_KIND.MACVLAN) {
    const address = macvlanAddress(target);

    if (!address) {
      return blocked(`${target.name} is on a macvlan network but has no address assigned.`);
    }

    return linked(
      LINK_STRATEGY.MACVLAN_IP,
      address,
      target.containerPort,
      `${target.name} is on the macvlan network ${target.networkMode} and answers on its own address. The host address is not used, because ${target.name} publishes no ports to it.`
    );
  }

  const binding = publishedBinding(target);

  if (!binding) {
    return blocked(
      `${target.name} publishes no ports and shares no network with ${source.name}, so there is no address that reaches it.`
    );
  }

  if (source.kind === ENDPOINT_KIND.BRIDGE) {
    return blocked(
      `${source.name} and ${target.name} are on separate Docker bridge networks, and this host does not route a container's request back to a port published on the host.`
    );
  }

  if (!binding.hostIp && !hostAddress) {
    return blocked(`${target.name} publishes a port, but no host address is configured for this stack.`);
  }

  return linked(
    LINK_STRATEGY.HOST_PUBLISHED,
    binding.hostIp || hostAddress,
    binding.hostPort,
    `${target.name} publishes port ${binding.containerPort} on the host as ${binding.hostPort}, and ${source.name} can reach the host directly.`
  );
}
