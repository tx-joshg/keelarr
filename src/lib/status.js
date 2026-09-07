import { access } from "node:fs/promises";
import { hostname } from "node:os";

import { scanDockerInventory } from "./import-scanner.js";
import { readActivity, readUpdateState } from "./store.js";
import { composePs, inspectContainers } from "./runtime.js";
import { probeAppUrl } from "./health.js";
import {
  LAN_CLIENT,
  buildEndpointFromInventory,
  inspectNetworkDrivers,
  loadControllerEndpoint,
  resolveLink
} from "./wiring/topology.js";
import { getServiceDefinition } from "./service-catalog.js";
import { findUnmountedRoots } from "./host-mounts.js";

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isLoopbackAppUrl(value) {
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function shouldProbeService(settings, service, inventoryItem, probeUrl) {
  if (settings.initialized !== true) {
    return false;
  }

  // No resolved address means this host's networking cannot carry a request
  // from the controller to this app at all. Probing anyway would either time
  // out or, worse, reach something else that happens to answer.
  if (!probeUrl || isLoopbackAppUrl(probeUrl)) {
    return false;
  }

  if (inventoryItem && inventoryItem.status !== "running") {
    return false;
  }

  return true;
}

export function selectInventoryItemForService(service, inventoryItems = []) {
  const candidates = inventoryItems.filter((item) => item.recognized && item.serviceId === service.id);

  if (candidates.length === 0) {
    return null;
  }

  return candidates.find((item) => item.containerId === service.sourceContainerId)
    || candidates.find((item) => item.containerName === service.sourceContainerName)
    || candidates.find((item) => item.containerName === service.containerName)
    || candidates[0];
}

/**
 * A container is Compose-managed when its labels point at the stack file
 * Keelarr generated for it. Reading the labels the inventory scan already
 * fetched replaces a `docker compose ps` process per service per refresh.
 */
export function isComposeManagedBy(inventoryItem, service) {
  const compose = inventoryItem?.compose;

  if (!compose) {
    return false;
  }

  if (compose.configFiles) {
    return compose.configFiles.split(",").some((file) => file.trim() === service.composePath);
  }

  return compose.project === service.id;
}

function deriveRuntimeStatus(runtime, inventoryItem, composeStatusOk) {
  if (runtime?.State) {
    return runtime.State;
  }

  if (inventoryItem?.status) {
    return inventoryItem.status;
  }

  return composeStatusOk ? "not-deployed" : "unknown";
}

function deriveHealthStatus(inventoryItem, probe) {
  if (inventoryItem?.healthStatus) {
    return inventoryItem.healthStatus;
  }

  if (probe?.reachable) {
    return "reachable";
  }

  if (inventoryItem?.status === "running") {
    return "running";
  }

  if (inventoryItem?.status) {
    return inventoryItem.status;
  }

  if (probe?.error) {
    return "unreachable";
  }

  return "unknown";
}

export function deriveReachable(inventoryItem, probe) {
  if (inventoryItem?.healthStatus === "healthy") {
    return true;
  }

  if (inventoryItem?.healthStatus === "unhealthy") {
    return false;
  }

  if (probe?.reachable === true) {
    return true;
  }

  // A running container is not a reachable app, and saying so was a false
  // green: a SABnzbd whose port never published showed as reachable, with a
  // link that opened whatever else happened to own that port on the host.
  //
  // Null rather than false, because "nothing asked" is not "asked and failed".
  // The dashboard renders the three differently, so an app the controller
  // cannot route to is not painted as down.
  if (inventoryItem?.status === "running") {
    return null;
  }

  return false;
}

/**
 * A port the compose file declares but Docker never bound.
 *
 * Happens when the port was already taken at create time. The container runs,
 * the app answers inside it, and nothing on the host can reach it — including
 * the link Keelarr shows, which then belongs to whichever service did get the
 * port. Keelarr already has this in the inventory; it just never said so.
 *
 * "Declares" is the load-bearing word, and reading it as "every port with no
 * host binding" produced a warning that was confidently wrong in two ways:
 *
 * - An image may EXPOSE ports Keelarr never publishes. FlareSolverr exposes
 *   8191 and 8192 and the catalog publishes only 8191, so 8192 was reported as
 *   a port conflict on every healthy install.
 * - A host-networked container publishes nothing at all, by design, and is
 *   reachable at the host address. `parsePorts` synthesises an entry per EXPOSE
 *   for those, so Radarr and Sonarr reported their own ports as stolen.
 *
 * Neither is a conflict, and both sent the operator hunting for one while
 * hiding the real reason the app was not green.
 */
export function findUnpublishedPorts(publishings = [], options = {}) {
  const { managedPort = null, networkMode = null } = options;

  if (networkMode === "host") {
    return [];
  }

  const unbound = publishings.filter((entry) => entry && entry.containerPort && !entry.hostPort);

  if (!unbound.length) {
    return [];
  }

  // Nothing bound at all is the case this warning was written for: whatever the
  // numbers are, the host cannot reach the container. Reported without matching
  // against the managed port, because an adopted service records its *host*
  // port there and a remapped container would otherwise slip through.
  if (!publishings.some((entry) => entry && entry.hostPort)) {
    return unbound.map((entry) => entry.containerPort);
  }

  // Something is bound, so the app is reachable and only the port Keelarr
  // manages is worth reporting. The rest are secondary EXPOSE lines.
  if (managedPort === null) {
    return [];
  }

  return unbound
    .filter((entry) => Number.parseInt(entry.containerPort, 10) === Number(managedPort))
    .map((entry) => entry.containerPort);
}

function deriveManagementState(service, generated, runtimeSource, inventoryItem) {
  if (runtimeSource === "compose") {
    return "managed";
  }

  if (service.managedMode === "imported-draft") {
    return inventoryItem ? "draft" : generated ? "generated" : "catalog";
  }

  if (inventoryItem) {
    return "detected";
  }

  if (generated) {
    return "generated";
  }

  return "catalog";
}

function deriveUpdateStatus(service, generated, runtimeSource, storedStatus) {
  if (runtimeSource !== "compose") {
    // An already cut-over service that is not running under Compose is simply
    // down. Reporting it as `cutover-pending` would invite a second cutover.
    if (service.managedMode === "imported") {
      return "unmanaged";
    }

    // `cutover-pending` is import language. A catalog service with generated
    // files that is simply not running has nothing to cut over.
    if (service.managedMode === "imported-draft") {
      return "cutover-pending";
    }

    return generated ? "not-deployed" : "unmanaged";
  }

  return storedStatus || "unchecked";
}

function buildDiagnostics(settings, controllerMounts = []) {
  // First, because a root the controller cannot see makes every other check
  // about that path meaningless.
  const diagnostics = findUnmountedRoots(settings, controllerMounts);

  if (!settings.downloadsRoot.startsWith(settings.mediaRoot)) {
    diagnostics.push({
      level: "warn",
      message: "Downloads root is outside the media root. Hardlinks and atomic moves may fail."
    });
  }

  if (settings.selectedServiceIds.includes("tautulli") && !settings.plexLogsRoot) {
    diagnostics.push({
      level: "warn",
      message: "Tautulli is enabled but Plex logs path is empty."
    });
  }

  if (!settings.hostUrl.startsWith("http://") && !settings.hostUrl.startsWith("https://")) {
    diagnostics.push({
      level: "warn",
      message: "Host URL should include http:// or https:// so deep links resolve correctly."
    });
  }

  return diagnostics;
}

function hostAddressFrom(settings) {
  try {
    return new URL(settings.hostUrl).hostname;
  } catch {
    return null;
  }
}

/**
 * The two lookups the address resolver needs, both cached.
 *
 * Network drivers change only when a network is created or removed, and the
 * controller's own attachment cannot change without restarting this process, so
 * neither costs anything after the first refresh.
 */
async function loadTopology(settings, items, { inspectContainersImpl, inspectNetworkDriversImpl }) {
  const drivers = await inspectNetworkDriversImpl(
    settings,
    items.flatMap((item) => (item.networks || []).map((network) => network.name))
  );
  const controller = await loadControllerEndpoint(settings, {
    inspectContainersImpl,
    hostname: hostname()
  });

  return { controller, drivers, hostAddress: hostAddressFrom(settings) };
}

export async function buildDashboardState(settings, dependencies = {}) {
  const {
    composePsImpl = composePs,
    inspectContainersImpl = inspectContainers,
    inspectNetworkDriversImpl = inspectNetworkDrivers,
    probeServiceImpl = probeAppUrl,
    readActivityImpl = readActivity,
    readUpdateStateImpl = readUpdateState,
    scanDockerInventoryImpl = scanDockerInventory
  } = dependencies;

  const [activity, updateState, inventory] = await Promise.all([
    readActivityImpl(),
    readUpdateStateImpl(),
    settings.initialized === true
      ? scanDockerInventoryImpl(settings)
      : Promise.resolve({
          items: []
        })
  ]);
  const shouldProbe = settings.initialized === true;

  // Both addresses come from the same resolver the wiring check uses, because
  // composing hostUrl with a port is wrong in ways that look like success: on
  // this host it points SABnzbd's health check at the NAS admin panel, which
  // answers 200 and hides the app being down.
  const { controller, drivers, hostAddress } = shouldProbe
    ? await loadTopology(settings, inventory.items, { inspectContainersImpl, inspectNetworkDriversImpl })
    : { controller: LAN_CLIENT, drivers: new Map(), hostAddress: null };

  const services = await Promise.all(settings.selectedServiceIds.map(async (serviceId) => {
    const service = settings.services[serviceId];
    const inventoryItem = selectInventoryItemForService(service, inventory.items);
    const endpoint = buildEndpointFromInventory({
      serviceId,
      name: service.name,
      containerName: service.containerName,
      fallbackPort: getServiceDefinition(serviceId)?.defaultPort || service.port,
      item: inventoryItem,
      networkDrivers: drivers
    });
    // What Keelarr must call to check the app, and what the person must click
    // to open it. Different network positions, so genuinely different answers.
    const fromController = resolveLink(controller, endpoint, { hostAddress });
    const fromBrowser = resolveLink(LAN_CLIENT, endpoint, { hostAddress });
    const probeUrl = fromController.ok ? fromController.baseUrl : null;
    const appUrl = fromBrowser.ok ? fromBrowser.baseUrl : service.appUrl;

    const [composeExists, envExists, probe] = await Promise.all([
      fileExists(service.composePath),
      fileExists(service.envPath),
      shouldProbe && shouldProbeService(settings, service, inventoryItem, probeUrl)
        ? probeServiceImpl({ ...service, appUrl: probeUrl })
        : Promise.resolve({
            reachable: false,
            latencyMs: null,
            httpStatus: null,
            error: null,
            notProbed: !probeUrl ? fromController.reason : null
          })
    ]);
    const generated = composeExists && envExists;

    const composeManaged = generated && isComposeManagedBy(inventoryItem, service);
    const composeStatus = { ok: true, data: [] };
    const runtime = null;
    const runtimeSource = composeManaged
      ? "compose"
      : inventoryItem
        ? "inventory"
        : "none";
    const managementState = deriveManagementState(service, generated, runtimeSource, inventoryItem);
    const runtimeStatus = deriveRuntimeStatus(runtime, inventoryItem, composeStatus.ok);
    const healthStatus = deriveHealthStatus(inventoryItem, probe);
    const reachable = deriveReachable(inventoryItem, probe);

    return {
      ...service,
      appUrl,
      // Named so the dashboard can say "not checked from here" rather than
      // rendering an unreachable-by-design app as though it were down.
      probe: {
        url: probeUrl,
        strategy: fromController.strategy,
        reason: fromController.reason,
        checked: Boolean(probeUrl)
      },
      generated,
      runtimeSource,
      managementState,
      runtimeStatus,
      publishings: inventoryItem?.ports || runtime?.Publishers || [],
      // Named separately from reachability so the dashboard can explain why an
      // app it cannot open is nonetheless running.
      unpublishedPorts: findUnpublishedPorts(inventoryItem?.ports || runtime?.Publishers || [], {
        managedPort: service.port,
        networkMode: inventoryItem?.networkMode || null
      }),
      networks: inventoryItem?.networks || [],
      reachable,
      healthStatus,
      httpStatus: probe.httpStatus,
      latencyMs: probe.latencyMs,
      observedImage: inventoryItem?.image || service.sourceImage || service.image,
      observedImageId: inventoryItem?.imageId || null,
      appVersion: inventoryItem?.appVersion || null,
      observedContainerId: inventoryItem?.containerId || service.sourceContainerId || null,
      observedContainerName: inventoryItem?.containerName || service.sourceContainerName || service.containerName,
      observedRestartPolicy: inventoryItem?.restartPolicy || service.restartPolicy,
      observedNetworkMode: inventoryItem?.networkMode || service.networkMode,
      resourceUsage: inventoryItem?.resourceUsage || null,
      lastError: probe.error || composeStatus.error || null,
      updateStatus: deriveUpdateStatus(service, generated, runtimeSource, updateState[service.id]?.status || null),
      updateCheckedAt: updateState[service.id]?.checkedAt || null,
      // Uptime is derived from this on the client, so it is not stale between
      // polls the way a server-computed number of seconds would be.
      startedAt: inventoryItem?.startedAt || null,
      restartCount: inventoryItem?.restartCount ?? null,
      lastUpgradedAt: updateState[service.id]?.upgradedAt || null
    };
  }));

  return {
    configured: settings.initialized === true,
    settings,
    services,
    diagnostics: buildDiagnostics(settings, controller?.mounts || []),
    activity
  };
}
