import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildServicesFromSelection } from "./service-catalog.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.STACKARR_DATA_DIR
  ? path.resolve(process.env.STACKARR_DATA_DIR)
  : path.resolve(here, "..", "..", "data");
const settingsPath = path.join(dataDir, "settings.json");
const activityPath = path.join(dataDir, "activity.json");
const updatesPath = path.join(dataDir, "updates.json");

export const defaultSettings = {
  initialized: false,
  projectName: "Stackarr",
  adapterType: "generic-docker",
  hostLabel: "Docker Host",
  dockerBin: "docker",
  stackRoot: "/opt/stackarr/stacks",
  configRoot: "/srv/stackarr/config",
  mediaRoot: "/srv/media",
  downloadsRoot: "/srv/media/downloads",
  plexLogsRoot: "",
  hostUrl: "http://localhost",
  tz: "America/Chicago",
  puid: "1000",
  pgid: "1000",
  ombiVersion: "latest",
  selectedServiceIds: ["prowlarr", "radarr", "sonarr", "bazarr", "trailarr", "ombi", "tautulli", "sabnzbd"],
  serviceOverrides: {},
  services: {}
};

async function ensureDataDir() {
  await mkdir(dataDir, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const value = await readFile(filePath, "utf8");
    return JSON.parse(value);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

async function writeJson(filePath, value) {
  await ensureDataDir();
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sanitizeSelectedServiceIds(value) {
  if (!Array.isArray(value)) {
    return defaultSettings.selectedServiceIds;
  }

  return [...new Set(value.filter((item) => typeof item === "string" && item.length > 0))];
}

function sanitizeServiceOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const overrides = {};

  for (const [serviceId, item] of Object.entries(value)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    overrides[serviceId] = {
      mode: typeof item.mode === "string" ? item.mode : null,
      image: typeof item.image === "string" ? item.image : null,
      port: Number.isFinite(Number(item.port)) ? Number(item.port) : null,
      containerName: typeof item.containerName === "string" ? item.containerName : null,
      restartPolicy: typeof item.restartPolicy === "string" ? item.restartPolicy : null,
      networkMode: typeof item.networkMode === "string" ? item.networkMode : null,
      envKeys: Array.isArray(item.envKeys) ? item.envKeys.filter((key) => typeof key === "string" && key.length > 0) : [],
      sourceContainerId: typeof item.sourceContainerId === "string" ? item.sourceContainerId : null,
      sourceContainerName: typeof item.sourceContainerName === "string" ? item.sourceContainerName : null,
      sourceImage: typeof item.sourceImage === "string" ? item.sourceImage : null,
      reviewSummaryPath: typeof item.reviewSummaryPath === "string" ? item.reviewSummaryPath : null,
      reviewNotesPath: typeof item.reviewNotesPath === "string" ? item.reviewNotesPath : null,
      importedAt: typeof item.importedAt === "string" ? item.importedAt : null
    };
  }

  return overrides;
}

export function normalizeSettings(input = {}) {
  const merged = {
    ...defaultSettings,
    ...input
  };

  merged.initialized = merged.initialized === true;
  merged.projectName = String(merged.projectName || defaultSettings.projectName).trim();
  merged.adapterType = String(merged.adapterType || defaultSettings.adapterType).trim();
  merged.hostLabel = String(merged.hostLabel || defaultSettings.hostLabel).trim();
  merged.dockerBin = String(merged.dockerBin || defaultSettings.dockerBin).trim();
  merged.stackRoot = String(merged.stackRoot || defaultSettings.stackRoot).trim();
  merged.configRoot = String(merged.configRoot || defaultSettings.configRoot).trim();
  merged.mediaRoot = String(merged.mediaRoot || defaultSettings.mediaRoot).trim();
  merged.downloadsRoot = String(merged.downloadsRoot || defaultSettings.downloadsRoot).trim();
  merged.plexLogsRoot = String(merged.plexLogsRoot || defaultSettings.plexLogsRoot).trim();
  merged.hostUrl = String(merged.hostUrl || defaultSettings.hostUrl).trim().replace(/\/+$/, "");
  merged.tz = String(merged.tz || defaultSettings.tz).trim();
  merged.puid = String(merged.puid || defaultSettings.puid).trim();
  merged.pgid = String(merged.pgid || defaultSettings.pgid).trim();
  merged.ombiVersion = String(merged.ombiVersion || defaultSettings.ombiVersion).trim();
  merged.selectedServiceIds = sanitizeSelectedServiceIds(merged.selectedServiceIds);
  merged.serviceOverrides = sanitizeServiceOverrides(merged.serviceOverrides);

  if (merged.selectedServiceIds.length === 0) {
    merged.selectedServiceIds = defaultSettings.selectedServiceIds;
  }

  merged.services = buildServicesFromSelection(merged, merged.selectedServiceIds, merged.serviceOverrides);

  return merged;
}

export async function loadSettings() {
  const stored = await readJson(settingsPath, null);
  return normalizeSettings(stored || {});
}

export async function saveSettings(input) {
  const normalized = normalizeSettings({
    ...input,
    initialized: true
  });
  await writeJson(settingsPath, normalized);
  return normalized;
}

export async function readActivity() {
  return readJson(activityPath, []);
}

export async function appendActivity(entry) {
  const current = await readActivity();
  const next = [
    {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      ...entry
    },
    ...current
  ].slice(0, 80);

  await writeJson(activityPath, next);
  return next;
}

export async function readUpdateState() {
  return readJson(updatesPath, {});
}

export async function writeUpdateState(nextState) {
  await writeJson(updatesPath, nextState);
  return nextState;
}
