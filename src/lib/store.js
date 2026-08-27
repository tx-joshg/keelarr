import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

import {
  activityPath,
  authPath,
  controllerUpdatePath,
  selfUpdateReceiptPath,
  dataDir,
  jobsPath,
  settingsPath,
  updatesPath
} from "./data-paths.js";
import { SERVICE_ORDER, buildServicesFromSelection } from "./service-catalog.js";

export const defaultSettings = {
  initialized: false,
  projectName: "Keelarr",
  adapterType: "generic-docker",
  hostLabel: "Docker Host",
  dockerBin: "docker",
  stackRoot: "/opt/keelarr/stacks",
  configRoot: "/srv/keelarr/config",
  mediaRoot: "/srv/media",
  downloadsRoot: "/srv/media/downloads",
  plexLogsRoot: "",
  hostUrl: "http://localhost",
  tz: "America/Chicago",
  // 911:911, not 1000:1000. Nine of the twelve catalog services are
  // linuxserver.io images, whose baseimage creates its `abc` user at 911:911
  // and only overrides it when PUID/PGID are passed. A library first populated
  // by any of them is therefore owned by 911, and a default of 1000 hands every
  // new service an identity that cannot write to it.
  puid: "911",
  pgid: "911",
  ombiVersion: "latest",
  // How many backups to keep per service. Every install, upgrade, and rollback
  // writes one, so without a cap they grow forever. 0 means keep all.
  backupRetention: 1,
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

export async function writeJson(filePath, value) {
  await ensureDataDir();

  // Write to a sibling temp file and rename so a crash mid-write cannot leave
  // a truncated settings/activity file behind. Rename is atomic within a
  // filesystem, and the temp file always lands in the same directory.
  const tempPath = `${filePath}.${process.pid}.tmp`;

  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

/**
 * Keeping zero backups would leave nothing to roll back to, so anything below
 * one is treated as "keep all" rather than "keep none" — the safe reading of
 * an out-of-range value.
 */
export function sanitizeBackupRetention(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return defaultSettings.backupRetention;
  }

  const rounded = Math.floor(numeric);
  return rounded <= 0 ? 0 : Math.min(rounded, 50);
}

function sanitizeSelectedServiceIds(value) {
  if (!Array.isArray(value)) {
    return defaultSettings.selectedServiceIds;
  }

  // Drop ids that are no longer in the catalog. A stored selection naming a
  // retired service would otherwise build no service object for it, and the
  // dashboard would crash reading properties off undefined.
  const known = new Set(SERVICE_ORDER);
  return [...new Set(value.filter((item) => typeof item === "string" && known.has(item)))];
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
      importedAt: typeof item.importedAt === "string" ? item.importedAt : null,
      cutoverAt: typeof item.cutoverAt === "string" ? item.cutoverAt : null,
      rollbackContainerName: typeof item.rollbackContainerName === "string" ? item.rollbackContainerName : null,
      // Set when a service was removed with its configuration kept: the backup
      // directory holding the stack files needed to bring it back as the same
      // service rather than as a fresh catalog one.
      restoreFrom: typeof item.restoreFrom === "string" ? item.restoreFrom : null
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
  merged.backupRetention = sanitizeBackupRetention(merged.backupRetention);
  merged.selectedServiceIds = sanitizeSelectedServiceIds(merged.selectedServiceIds);
  merged.serviceOverrides = sanitizeServiceOverrides(merged.serviceOverrides);

  // Only a stack that has never been set up gets the default selection. Once
  // the operator has been through setup, an empty list is a decision — usually
  // "I just removed the last service" — and refilling it puts eight apps they
  // did not ask for back on the dashboard.
  if (!merged.initialized && merged.selectedServiceIds.length === 0) {
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

export async function readControllerUpdateState() {
  return readJson(controllerUpdatePath, {});
}

export async function writeControllerUpdateState(nextState) {
  await writeJson(controllerUpdatePath, nextState);
  return nextState;
}

export async function readSelfUpdateReceipt() {
  return readJson(selfUpdateReceiptPath, null);
}

export async function writeSelfUpdateReceipt(receipt) {
  await writeJson(selfUpdateReceiptPath, receipt);
  return receipt;
}

export async function readUpdateState() {
  return readJson(updatesPath, {});
}

export async function writeUpdateState(nextState) {
  await writeJson(updatesPath, nextState);
  return nextState;
}

export async function readAuth() {
  return readJson(authPath, null);
}

export async function writeAuth(record) {
  await writeJson(authPath, record);

  // Readable only by the account that runs the controller. The file holds the
  // password hash and the session signing secret, and the data directory is a
  // bind mount that other users on the host can otherwise read.
  await chmod(authPath, 0o600).catch(() => {});

  return record;
}

export async function readJobs() {
  const stored = await readJson(jobsPath, []);
  return Array.isArray(stored) ? stored : [];
}

export async function writeJobs(jobs) {
  await writeJson(jobsPath, jobs);
  return jobs;
}
