import { access } from "node:fs/promises";

import { scanDockerInventory } from "./import-scanner.js";
import { readActivity, readUpdateState } from "./store.js";
import { composePs } from "./runtime.js";

function isHealthyStatus(status, accepted) {
  return accepted.includes(status);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function probeService(service) {
  try {
    const startedAt = Date.now();
    const response = await fetch(service.appUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(2500)
    });

    const latencyMs = Date.now() - startedAt;

    return {
      reachable: isHealthyStatus(response.status, service.healthStatuses),
      latencyMs,
      httpStatus: response.status
    };
  } catch (error) {
    return {
      reachable: false,
      latencyMs: null,
      httpStatus: null,
      error: error.message
    };
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
    return service.managedMode === "imported-draft" || generated
      ? "cutover-pending"
      : "unmanaged";
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
    probeServiceImpl = probeService,
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
      observedContainerId: inventoryItem?.containerId || service.sourceContainerId || null,
      observedContainerName: inventoryItem?.containerName || service.sourceContainerName || service.containerName,
      observedRestartPolicy: inventoryItem?.restartPolicy || service.restartPolicy,
      observedNetworkMode: inventoryItem?.networkMode || service.networkMode,
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
