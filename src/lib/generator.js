import { mkdir, writeFile } from "node:fs/promises";

import YAML from "yaml";

import { buildComposeSpec } from "./service-catalog.js";

function buildEnvLines(settings, service) {
  const lines = [
    `PUID=${settings.puid}`,
    `PGID=${settings.pgid}`,
    `TZ=${settings.tz}`,
    `PORT=${service.port}`,
    `CONFIG_DIR=${service.configDir}`,
    `MEDIA_DIR=${settings.mediaRoot}`
  ];

  if (service.id === "ombi") {
    lines.push(`OMBI_VERSION=${settings.ombiVersion}`);
  }

  if (service.volumes.includes("plex_logs")) {
    lines.push(`PLEX_LOGS_DIR=${settings.plexLogsRoot}`);
  }

  if (service.id === "sabnzbd") {
    lines.push(`DOWNLOADS_DIR=${settings.downloadsRoot}`);
  }

  return `${lines.join("\n")}\n`;
}

async function writeServiceFiles(settings, service) {
  await mkdir(service.stackDir, { recursive: true });

  const composeSpec = buildComposeSpec(settings, service);
  const composeText = YAML.stringify(composeSpec);
  const envText = buildEnvLines(settings, service);

  await writeFile(service.composePath, composeText, "utf8");
  await writeFile(service.envPath, envText, "utf8");
  await writeFile(service.envExamplePath, envText, "utf8");

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

  return {
    serviceId: draft.serviceId,
    composePath: draft.composePath,
    envPath: draft.envPath,
    envExamplePath: draft.envExamplePath
  };
}

export async function writeStacks(settings, serviceIds = settings.selectedServiceIds) {
  const writes = [];

  for (const serviceId of serviceIds) {
    const service = settings.services[serviceId];

    if (!service?.enabled) {
      continue;
    }

    writes.push(await writeServiceFiles(settings, service));
  }

  return writes;
}
