import path from "node:path";
import { access, mkdir, writeFile } from "node:fs/promises";

import YAML from "yaml";

import { buildComposeSpec } from "./service-catalog.js";
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

export async function writeStacks(settings, serviceIds = settings.selectedServiceIds) {
  const writes = [];

  for (const serviceId of serviceIds) {
    const service = settings.services[serviceId];

    if (!service?.enabled) {
      continue;
    }

    if (service.managedMode === "imported-draft") {
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
