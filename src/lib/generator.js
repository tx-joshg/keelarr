import path from "node:path";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

import YAML from "yaml";

import { buildComposeSpec, getServiceDefinition, isImportedMode } from "./service-catalog.js";
import { KeelarrError } from "./errors.js";

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function buildEnvEntries(settings, service) {
  const definition = getServiceDefinition(service.id);
  const catalogEnvironment = definition?.buildEnvironment?.(service) || {};
  const entries = [
    // Only for services whose compose actually reads them. FlareSolverr runs as
    // its own user and owns nothing on disk, so writing PUID into its .env
    // states a control that does not exist and invites someone to change it
    // expecting an effect.
    ...(Object.hasOwn(catalogEnvironment, "PUID") ? [["PUID", settings.puid], ["PGID", settings.pgid]] : []),
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
    throw new KeelarrError(`No service block found in ${service.composePath}.`, {
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

/**
 * Applies the centrally configured identity to a stack Keelarr does not
 * otherwise regenerate.
 *
 * An imported stack keeps the shape of the container it was adopted from —
 * image, ports, mounts, command — because that shape is the thing that was
 * known to work. Identity is the one exception, and it has to be, because
 * PUID and PGID are not a property of a single container: they decide whether
 * an app can write files that a *different* app created in the shared library.
 * Left to each image's own default, a linuxserver app lands on 911 and a
 * non-linuxserver one on 1000, and the second cannot write into folders the
 * first made. Only those two keys are touched; everything else in the adopted
 * file is left exactly as imported.
 */
export async function reconcileStackIdentity(settings, service) {
  const definition = getServiceDefinition(service.id);
  const catalogEnvironment = definition?.buildEnvironment?.(service) || {};

  if (!Object.hasOwn(catalogEnvironment, "PUID")) {
    return null;
  }

  const composeText = await readFile(service.composePath, "utf8");
  const spec = YAML.parse(composeText);
  const serviceKey = spec?.services?.[service.id] ? service.id : Object.keys(spec?.services || {})[0];

  if (!serviceKey) {
    throw new KeelarrError(`No service block was found in ${service.composePath}, so its identity cannot be set.`, {
      statusCode: 400
    });
  }

  const composeService = spec.services[serviceKey];
  let composeChanged = false;

  // Compose accepts `environment` as either a map or a list of KEY=VALUE
  // strings. An adopted file may hold either, so both are updated in place
  // rather than normalised to one form and rewritten wholesale.
  if (Array.isArray(composeService.environment)) {
    for (const key of ["PUID", "PGID"]) {
      const desired = `${key}=\${${key}}`;
      const index = composeService.environment.findIndex((entry) => String(entry).split("=")[0].trim() === key);

      if (index === -1) {
        composeService.environment.push(desired);
        composeChanged = true;
      } else if (composeService.environment[index] !== desired) {
        composeService.environment[index] = desired;
        composeChanged = true;
      }
    }
  } else {
    const environment = composeService.environment || {};

    for (const key of ["PUID", "PGID"]) {
      const desired = `\${${key}}`;

      if (environment[key] !== desired) {
        environment[key] = desired;
        composeChanged = true;
      }
    }

    composeService.environment = environment;
  }

  if (composeChanged) {
    await writeFile(service.composePath, YAML.stringify(spec), "utf8");
  }

  // The compose file references the keys; .env carries this host's values.
  const envText = await readFile(service.envPath, "utf8").catch(() => "");
  const desiredValues = { PUID: String(settings.puid), PGID: String(settings.pgid) };
  const lines = envText.length ? envText.replace(/\n+$/, "").split("\n") : [];
  const rendered = [];
  const seen = new Set();
  let envChanged = false;

  for (const line of lines) {
    const key = line.split("=")[0].trim();

    if (Object.hasOwn(desiredValues, key)) {
      const next = `${key}=${desiredValues[key]}`;

      if (line !== next) {
        envChanged = true;
      }

      rendered.push(next);
      seen.add(key);
      continue;
    }

    rendered.push(line);
  }

  for (const [key, value] of Object.entries(desiredValues)) {
    if (!seen.has(key)) {
      rendered.push(`${key}=${value}`);
      envChanged = true;
    }
  }

  if (envChanged) {
    await writeFile(service.envPath, `${rendered.join("\n")}\n`, "utf8");
  }

  return {
    serviceId: service.id,
    composeChanged,
    envChanged,
    puid: desiredValues.PUID,
    pgid: desiredValues.PGID
  };
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
        throw new KeelarrError(`Imported draft files are missing for ${service.name}. Re-run the adoption draft before deploying.`, {
          statusCode: 400
        });
      }

      const identity = await reconcileStackIdentity(settings, service);

      writes.push({
        serviceId: service.id,
        composePath: service.composePath,
        envPath: service.envPath,
        envExamplePath: service.envExamplePath,
        reviewSummaryPath: service.reviewSummaryPath,
        reviewNotesPath: service.reviewNotesPath,
        identity
      });
      continue;
    }

    writes.push(await writeServiceFiles(settings, service));
  }

  return writes;
}
