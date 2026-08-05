import { access } from "node:fs/promises";

import { scanDockerInventory } from "./import-scanner.js";
import { readActivity, readUpdateState } from "./store.js";
import { composePs } from "./runtime.js";
import { probeAppUrl } from "./health.js";

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

function shouldProbeService(settings, service, inventoryItem) {
  if (settings.initialized !== true) {
    return false;
  }

  if (!service?.appUrl || isLoopbackAppUrl(service.appUrl)) {
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

function deriveReachable(inventoryItem, probe) {
  if (inventoryItem?.healthStatus === "healthy") {
    return true;
  }

  if (inventoryItem?.healthStatus === "unhealthy") {
    return false;
  }

  if (probe?.reachable === true) {
    return true;
  }

  if (inventoryItem?.status === "running") {
    return true;
  }

  return false;
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

function buildDiagnostics(settings) {
  const diagnostics = [];

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

export async function buildDashboardState(settings, dependencies = {}) {
  const {
    composePsImpl = composePs,
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
  const services = await Promise.all(settings.selectedServiceIds.map(async (serviceId) => {
    const service = settings.services[serviceId];
    const inventoryItem = selectInventoryItemForService(service, inventory.items);
    const [composeExists, envExists, probe] = await Promise.all([
      fileExists(service.composePath),
      fileExists(service.envPath),
      shouldProbe && shouldProbeService(settings, service, inventoryItem)
        ? probeServiceImpl(service)
        : Promise.resolve({
            reachable: false,
            latencyMs: null,
            httpStatus: null,
            error: null
          })
    ]);
    const generated = composeExists && envExists;

    const composeStatus =
      shouldProbe && generated
        ? await composePsImpl(settings, service)
        : {
            ok: true,
            data: []
          };

    const runtime = composeStatus.ok ? composeStatus.data[0] || null : null;
    const runtimeSource = runtime
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
      generated,
      runtimeSource,
      managementState,
      runtimeStatus,
      publishings: inventoryItem?.ports || runtime?.Publishers || [],
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
      updateCheckedAt: updateState[service.id]?.checkedAt || null
    };
  }));

  return {
    configured: settings.initialized === true,
    settings,
    services,
    diagnostics: buildDiagnostics(settings),
    activity
  };
}
