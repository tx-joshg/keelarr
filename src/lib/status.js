import { access } from "node:fs/promises";

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

export async function buildDashboardState(settings) {
  const [activity, updateState] = await Promise.all([readActivity(), readUpdateState()]);
  const shouldProbe = settings.initialized === true;
  const services = await Promise.all(settings.selectedServiceIds.map(async (serviceId) => {
    const service = settings.services[serviceId];
    const [composeExists, envExists, probe] = await Promise.all([
      fileExists(service.composePath),
      fileExists(service.envPath),
      shouldProbe
        ? probeService(service)
        : Promise.resolve({
            reachable: false,
            latencyMs: null,
            httpStatus: null,
            error: null
          })
    ]);

    const composeStatus =
      shouldProbe && composeExists && envExists
        ? await composePs(settings, service)
        : {
            ok: true,
            data: []
          };

    const runtime = composeStatus.ok ? composeStatus.data[0] || null : null;
    return {
      ...service,
      generated: composeExists && envExists,
      runtimeStatus: runtime?.State || (composeStatus.ok ? "not-deployed" : "unknown"),
      publishings: runtime?.Publishers || [],
      reachable: probe.reachable,
      httpStatus: probe.httpStatus,
      latencyMs: probe.latencyMs,
      lastError: probe.error || composeStatus.error || null,
      updateStatus: updateState[service.id]?.status || "unchecked",
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
