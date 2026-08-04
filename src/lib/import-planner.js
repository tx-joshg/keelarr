import { access } from "node:fs/promises";

import { buildServiceFromCatalog } from "./service-catalog.js";

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getMountForTarget(mounts, target) {
  return mounts.find((mount) => mount.target === target) || null;
}

function preservationItem(label, mount, expectedTarget, required = true) {
  if (!mount) {
    return {
      label,
      status: required ? "missing" : "optional",
      source: null,
      target: expectedTarget,
      note: required
        ? `Expected mount at ${expectedTarget} was not found on the existing container.`
        : `Optional mount at ${expectedTarget} is not currently configured.`
    };
  }

  return {
    label,
    status: "ready",
    source: mount.source,
    target: mount.target,
    note: `${mount.source} will stay on disk and should be preserved during cutover.`
  };
}

export async function buildImportPreview(settings, item, options = {}) {
  const demo = options.demo === true;

  if (!item) {
    throw new Error("Import candidate was not found.");
  }

  if (!item.recognized || !item.serviceId) {
    return {
      ok: true,
      supported: false,
      adoptable: false,
      source: {
        containerId: item.containerId,
        containerName: item.containerName,
        image: item.image
      },
      warnings: item.issues || [],
      recommendedSteps: [
        "Leave this container outside Stackarr management for now.",
        "Use the scan results to document its mounts, ports, and environment.",
        "Add support to Stackarr later only if this app belongs in the Arr-focused scope."
      ]
    };
  }

  const target = buildServiceFromCatalog(settings, item.serviceId);
  if (demo) {
    target.appUrl = `/demo/apps/${target.id}`;
  }

  const [composeExists, envExists] = await Promise.all([
    fileExists(target.composePath),
    fileExists(target.envPath)
  ]);

  const configMount = getMountForTarget(item.mounts, "/config");
  const mediaMount = getMountForTarget(item.mounts, "/Media");
  const plexLogsMount = getMountForTarget(item.mounts, "/plex_logs");
  const warnings = [...(item.issues || [])];

  if (item.containerName !== target.containerName) {
    warnings.push({
      level: "info",
      message: `Current container name is ${item.containerName}, while the managed Compose draft will use ${target.containerName}.`
    });
  }

  if (composeExists || envExists) {
    warnings.push({
      level: "info",
      message: "Stackarr draft files already exist for this service and will be overwritten by a new managed draft."
    });
  }

  const preservation = [preservationItem("Config", configMount, "/config", true)];

  if (target.volumes.includes("media") || mediaMount) {
    preservation.push(preservationItem("Media", mediaMount, "/Media", target.volumes.includes("media")));
  }

  if (target.volumes.includes("plex_logs") || plexLogsMount) {
    preservation.push(preservationItem("Plex Logs", plexLogsMount, "/plex_logs", target.volumes.includes("plex_logs")));
  }

  return {
    ok: true,
    supported: true,
    adoptable: item.adoptable === true,
    source: {
      containerId: item.containerId,
      containerName: item.containerName,
      image: item.image,
      serviceName: item.serviceName,
      matchedBy: item.matchedBy,
      status: item.status,
      restartPolicy: item.restartPolicy,
      networkMode: item.networkMode,
      ports: item.ports,
      mounts: item.mounts,
      networks: item.networks,
      envKeys: item.envKeys
    },
    target: {
      serviceId: target.id,
      serviceName: target.name,
      image: target.image,
      port: target.port,
      stackDir: target.stackDir,
      composePath: target.composePath,
      envPath: target.envPath,
      envExamplePath: target.envExamplePath,
      configDir: target.configDir,
      mediaDir: target.mediaDir,
      downloadsDir: target.downloadsDir,
      plexLogsDir: target.plexLogsDir,
      appUrl: target.appUrl
    },
    draftArtifacts: {
      composeExists,
      envExists
    },
    preservation,
    warnings,
    recommendedSteps: [
      "Confirm the current persistent config path matches the mounted /config source.",
      "Generate the managed draft first so Compose and .env files can be reviewed without stopping the live container.",
      "Compare ports, mounts, restart policy, and network mode before any cutover.",
      "Only stop and recreate the live container after the managed draft has been reviewed and backed up."
    ]
  };
}
