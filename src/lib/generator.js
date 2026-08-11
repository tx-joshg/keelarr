import path from "node:path";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

import YAML from "yaml";

import { buildComposeSpec, isImportedMode } from "./service-catalog.js";
import { StackarrError } from "./errors.js";

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function buildEnvEntries(settings, service) {
  const entries = [
    ["PUID", settings.puid],
    ["PGID", settings.pgid],
    ["TZ", settings.tz],
    ["PORT", service.port],
    ["CONFIG_DIR", service.configDir],
    ["MEDIA_DIR", settings.mediaRoot]
  ];

  if (service.id === "ombi") {
    entries.push(["OMBI_VERSION", settings.ombiVersion]);
  }

  if (service.volumes.includes("plex_logs")) {
    entries.push(["PLEX_LOGS_DIR", settings.plexLogsRoot]);
  }

  if (service.id === "sabnzbd") {
    entries.push(["DOWNLOADS_DIR", settings.downloadsRoot]);
  }

  return entries;
}

export function renderEnvText(entries) {
  return `${entries.map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

// The example file documents which keys a stack expects without baking in this
// host's resolved values, matching how imported drafts render `.env.example`.
export function renderEnvExampleText(entries) {
  return `${entries.map(([key]) => `${key}=`).join("\n")}\n`;
}

async function writeServiceFiles(settings, service) {
  await mkdir(service.stackDir, { recursive: true });

  const composeSpec = buildComposeSpec(settings, service);
  const composeText = YAML.stringify(composeSpec);
  const envEntries = buildEnvEntries(settings, service);

  await writeFile(service.composePath, composeText, "utf8");
  await writeFile(service.envPath, renderEnvText(envEntries), "utf8");
  await writeFile(service.envExamplePath, renderEnvExampleText(envEntries), "utf8");

  return {
    serviceId: service.id,
    composePath: service.composePath,
    envPath: service.envPath
  };
}

/**
 * Rewrites the image reference inside a managed compose file.
 *
 * Rolling back pins the image directly in compose.yml rather than layering an
 * override file, so every later `compose` call — ps, up, down — sees the same
 * config. A pin stays until an upgrade explicitly clears it.
 */
export async function setComposeImage(service, imageRef) {
  const text = await readFile(service.composePath, "utf8");
  const spec = YAML.parse(text);
  const serviceKey = Object.keys(spec?.services || {})[0];

  if (!serviceKey) {
    throw new StackarrError(`No service block found in ${service.composePath}.`, {
      statusCode: 500
    });
  }

  const previous = spec.services[serviceKey].image || null;
  spec.services[serviceKey].image = imageRef;
  await writeFile(service.composePath, YAML.stringify(spec), "utf8");

  return {
    composePath: service.composePath,
    previousImage: previous,
    image: imageRef
  };
}

export async function readComposeImage(service) {
  const text = await readFile(service.composePath, "utf8");
  const spec = YAML.parse(text);
  const serviceKey = Object.keys(spec?.services || {})[0];
  return serviceKey ? spec.services[serviceKey].image || null : null;
}

export async function writeDraftFiles(draft) {
  await mkdir(draft.stackDir, { recursive: true });
  await writeFile(draft.composePath, draft.composeYaml, "utf8");
  await writeFile(draft.envPath, draft.envText, "utf8");
  await writeFile(draft.envExamplePath, draft.envExampleText, "utf8");

  const reviewSummaryPath = path.join(draft.stackDir, "import-summary.json");
  const reviewNotesPath = path.join(draft.stackDir, "IMPORT-REVIEW.md");

  if (draft.reviewSummary) {
    await writeFile(reviewSummaryPath, `${JSON.stringify(draft.reviewSummary, null, 2)}\n`, "utf8");
  }

  if (draft.reviewNotes) {
    await writeFile(reviewNotesPath, `${draft.reviewNotes}\n`, "utf8");
  }

  return {
    serviceId: draft.serviceId,
    composePath: draft.composePath,
    envPath: draft.envPath,
    envExamplePath: draft.envExamplePath,
    reviewSummaryPath: draft.reviewSummary ? reviewSummaryPath : null,
    reviewNotesPath: draft.reviewNotes ? reviewNotesPath : null
  };
}

/**
 * Puts an archived stack back before generation runs.
 *
 * A service removed with its configuration kept records where its stack files
 * were archived. Restoring them is what lets an imported service come back as
 * itself: its compose file is the only surviving description of the image,
 * network mode, and — critically — the named volume holding its database.
 * Regenerating from the catalog instead produces a service pointing at a bind
 * path that has never existed, which starts up empty.
 *
 * Never overwrites a stack that is already in place.
 */
export async function restoreArchivedStack(service) {
  if (!service?.restoreFrom || (await fileExists(service.composePath))) {
    return null;
  }

  const archivedCompose = path.join(service.restoreFrom, "compose.yml");

  if (!(await fileExists(archivedCompose))) {
    return null;
  }

  await mkdir(service.stackDir, { recursive: true });
  await copyFile(archivedCompose, service.composePath);

  // Imported stacks are self-contained and may have no .env at all, so its
  // absence is normal rather than a failure.
  const archivedEnv = path.join(service.restoreFrom, ".env");

  if (await fileExists(archivedEnv)) {
    await copyFile(archivedEnv, service.envPath);
  } else if (!(await fileExists(service.envPath))) {
    await writeFile(service.envPath, "", "utf8");
  }

  return { serviceId: service.id, restoredFrom: service.restoreFrom };
}

export async function writeStacks(settings, serviceIds = settings.selectedServiceIds) {
  const writes = [];

  for (const serviceId of serviceIds) {
    const service = settings.services[serviceId];

    if (!service?.enabled) {
      continue;
    }

    if (isImportedMode(service.managedMode)) {
      await restoreArchivedStack(service);

      const composeExists = await fileExists(service.composePath);
      const envExists = await fileExists(service.envPath);

      if (!composeExists || !envExists) {
        throw new StackarrError(`Imported draft files are missing for ${service.name}. Re-run the adoption draft before deploying.`, {
          statusCode: 400
        });
      }

      writes.push({
        serviceId: service.id,
        composePath: service.composePath,
        envPath: service.envPath,
        envExamplePath: service.envExamplePath,
        reviewSummaryPath: service.reviewSummaryPath,
        reviewNotesPath: service.reviewNotesPath
      });
      continue;
    }

    writes.push(await writeServiceFiles(settings, service));
  }

  return writes;
}
