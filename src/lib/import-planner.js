import { access } from "node:fs/promises";

import YAML from "yaml";

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

const SYSTEM_ENV_KEYS = new Set([
  "HOME",
  "HOSTNAME",
  "LANG",
  "PATH",
  "PWD",
  "SHLVL",
  "TERM"
]);

function envRef(key) {
  return `\${${key}}`;
}

function filterImportedEnvironment(environment = {}) {
  const kept = {};

  for (const key of Object.keys(environment).sort()) {
    if (!key || SYSTEM_ENV_KEYS.has(key)) {
      continue;
    }

    kept[key] = environment[key];
  }

  return kept;
}

function buildEnvironmentSpec(environment = {}, fallbackKeys = []) {
  const keys = [...new Set([...Object.keys(environment), ...fallbackKeys])]
    .filter(Boolean)
    .sort();
  const composeEnvironment = {};

  for (const key of keys) {
    composeEnvironment[key] = envRef(key);
  }

  return {
    envKeys: keys,
    composeEnvironment,
    envText: `${keys.map((key) => `${key}=${environment[key] ?? ""}`).join("\n")}${keys.length ? "\n" : ""}`,
    envExampleText: `${keys.map((key) => `${key}=`).join("\n")}${keys.length ? "\n" : ""}`
  };
}

function buildImportedPort(port) {
  const containerValue = String(port.containerPort || "");
  const [containerPort, protocol = null] = containerValue.split("/");
  const protocolSuffix = protocol ? `/${protocol}` : "";

  if (!port.hostPort) {
    return `${containerPort}${protocolSuffix}`;
  }

  if (port.hostIp && port.hostIp !== "0.0.0.0") {
    return `${port.hostIp}:${port.hostPort}:${containerPort}${protocolSuffix}`;
  }

  return `${port.hostPort}:${containerPort}${protocolSuffix}`;
}

function volumeAlias(serviceId, mount, index) {
  const target = String(mount.target || "")
    .replace(/^\/+/, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || `volume_${index + 1}`;

  return `${serviceId}_${target}`;
}

function buildVolumeArtifacts(serviceId, mounts = []) {
  const volumes = {};
  const serviceVolumes = [];

  mounts.forEach((mount, index) => {
    const suffix = mount.mode === "ro" ? ":ro" : "";

    if (mount.type === "volume") {
      const alias = volumeAlias(serviceId, mount, index);
      serviceVolumes.push(`${alias}:${mount.target}${suffix}`);
      volumes[alias] = {
        external: true,
        name: mount.name || mount.source
      };
      return;
    }

    serviceVolumes.push(`${mount.source}:${mount.target}${suffix}`);
  });

  return {
    serviceVolumes,
    volumes
  };
}

function buildNetworkArtifacts(item) {
  if (item.networkMode === "host" || item.networkMode === "none") {
    return {
      networkMode: item.networkMode,
      serviceNetworks: null,
      networks: null
    };
  }

  const externalNetworks = (item.networks || []).filter((network) => !["bridge", "host", "none"].includes(network.name));

  if (!externalNetworks.length) {
    return {
      networkMode: null,
      serviceNetworks: null,
      networks: null
    };
  }

  const serviceNetworks = {};
  const networks = {};

  for (const network of externalNetworks) {
    serviceNetworks[network.name] = network.address ? { ipv4_address: network.address } : {};
    networks[network.name] = {
      external: true,
      name: network.name
    };
  }

  return {
    networkMode: null,
    serviceNetworks,
    networks
  };
}

export function buildImportDraftArtifacts(settings, item) {
  const target = buildServiceFromCatalog(settings, item.serviceId);
  const filteredEnvironment = filterImportedEnvironment(item.environment || {});
  const environmentArtifacts = buildEnvironmentSpec(filteredEnvironment, item.envKeys || []);
  const volumeArtifacts = buildVolumeArtifacts(target.id, item.mounts || []);
  const networkArtifacts = buildNetworkArtifacts(item);
  const composeService = {
    container_name: item.containerName || target.containerName,
    image: item.image || target.image,
    restart: item.restartPolicy || "unless-stopped"
  };

  if (Object.keys(environmentArtifacts.composeEnvironment).length) {
    composeService.environment = environmentArtifacts.composeEnvironment;
  }

  if (volumeArtifacts.serviceVolumes.length) {
    composeService.volumes = volumeArtifacts.serviceVolumes;
  }

  if (item.networkMode === "host" || item.networkMode === "none") {
    composeService.network_mode = item.networkMode;
  } else if (networkArtifacts.serviceNetworks) {
    composeService.networks = networkArtifacts.serviceNetworks;
  }

  if (item.networkMode !== "host" && item.ports?.length) {
    composeService.ports = item.ports.map((port) => buildImportedPort(port));
  }

  if (Array.isArray(item.entrypoint) && item.entrypoint.length) {
    composeService.entrypoint = item.entrypoint;
  }

  if (Array.isArray(item.command) && item.command.length) {
    composeService.command = item.command;
  }

  const composeSpec = {
    name: target.id,
    services: {
      [target.id]: composeService
    }
  };

  if (Object.keys(volumeArtifacts.volumes).length) {
    composeSpec.volumes = volumeArtifacts.volumes;
  }

  if (networkArtifacts.networks) {
    composeSpec.networks = networkArtifacts.networks;
  }

  return {
    serviceId: target.id,
    serviceName: target.name,
    composeSpec,
    composeYaml: YAML.stringify(composeSpec),
    envKeys: environmentArtifacts.envKeys,
    envText: environmentArtifacts.envText,
    envExampleText: environmentArtifacts.envExampleText,
    containerName: composeService.container_name,
    image: composeService.image,
    restartPolicy: composeService.restart,
    networkMode: item.networkMode,
    stackDir: target.stackDir,
    composePath: target.composePath,
    envPath: target.envPath,
    envExamplePath: target.envExamplePath,
    reviewSummaryPath: target.reviewSummaryPath || `${target.stackDir}/import-summary.json`,
    reviewNotesPath: target.reviewNotesPath || `${target.stackDir}/IMPORT-REVIEW.md`,
    configDir: target.configDir,
    mediaDir: target.mediaDir,
    downloadsDir: target.downloadsDir,
    plexLogsDir: target.plexLogsDir,
    appUrl: target.appUrl
  };
}

function formatReviewList(items = []) {
  if (!items.length) {
    return "- none";
  }

  return items.map((item) => `- ${item}`).join("\n");
}

export function buildImportReviewArtifacts(preview, generatedAt = new Date().toISOString()) {
  const summary = {
    generatedAt,
    source: preview.source,
    target: preview.target,
    preservation: preview.preservation,
    warnings: preview.warnings,
    recommendedSteps: preview.recommendedSteps,
    draftArtifacts: preview.draftArtifacts,
    draft: {
      restartPolicy: preview.draft?.restartPolicy || null,
      networkMode: preview.draft?.networkMode || null,
      containerName: preview.draft?.containerName || null,
      envKeys: preview.draft?.envKeys || []
    }
  };

  const markdown = [
    `# Import Review: ${preview.source.containerName} -> ${preview.target.serviceName}`,
    "",
    "## Source",
    `- Container ID: ${preview.source.containerId}`,
    `- Container Name: ${preview.source.containerName}`,
    `- Image: ${preview.source.image}`,
    `- Status: ${preview.source.status}`,
    `- Restart Policy: ${preview.source.restartPolicy}`,
    `- Network Mode: ${preview.source.networkMode}`,
    preview.source.ports?.length ? `- Ports: ${preview.source.ports.map((port) => port.display).join(", ")}` : "- Ports: none",
    preview.source.networks?.length ? `- Networks: ${preview.source.networks.map((network) => `${network.name}${network.address ? ` (${network.address})` : ""}`).join(", ")}` : "- Networks: none",
    preview.source.envKeys?.length ? `- Env Keys: ${preview.source.envKeys.join(", ")}` : "- Env Keys: none",
    "",
    "## Managed Draft",
    `- Service ID: ${preview.target.serviceId}`,
    `- Compose Path: ${preview.draftArtifacts.composePath}`,
    `- Env Path: ${preview.draftArtifacts.envPath}`,
    `- Env Example Path: ${preview.draftArtifacts.envExamplePath}`,
    `- Draft Container Name: ${preview.draft?.containerName || preview.target.containerName}`,
    `- Draft Restart Policy: ${preview.draft?.restartPolicy || preview.target.restartPolicy || "unless-stopped"}`,
    `- Draft Network Mode: ${preview.draft?.networkMode || preview.target.networkMode || "default"}`,
    preview.draft?.envKeys?.length ? `- Draft Env Keys: ${preview.draft.envKeys.join(", ")}` : "- Draft Env Keys: none",
    "",
    "## Preserved Paths",
    ...preview.preservation.map((item) => `- ${item.label}: ${item.source || "missing"} -> ${item.target} (${item.status})`),
    "",
    "## Warnings",
    formatReviewList((preview.warnings || []).map((item) => `${item.level}: ${item.message}`)),
    "",
    "## Recommended Steps",
    formatReviewList(preview.recommendedSteps || []),
    "",
    "## Notes",
    "- `.env` is local-only and may contain secret values copied from the running container.",
    "- `import-summary.json` is safe to review and commit because it records env keys, not env values.",
    `- Generated At: ${generatedAt}`
  ].join("\n");

  return {
    summary,
    markdown
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

  const baseTarget = buildServiceFromCatalog(settings, item.serviceId);
  const draft = buildImportDraftArtifacts(settings, item);
  const target = {
    id: draft.serviceId,
    name: draft.serviceName,
    image: draft.image,
    port: item.ports?.[0]?.hostPort ? Number(item.ports[0].hostPort) : baseTarget.port,
    stackDir: draft.stackDir,
    composePath: draft.composePath,
    envPath: draft.envPath,
    envExamplePath: draft.envExamplePath,
    configDir: draft.configDir,
    mediaDir: draft.mediaDir,
    downloadsDir: draft.downloadsDir,
    plexLogsDir: draft.plexLogsDir,
    appUrl: draft.appUrl,
    containerName: draft.containerName,
    restartPolicy: draft.restartPolicy,
    networkMode: draft.networkMode,
    volumes: baseTarget.volumes
  };
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
      containerName: target.containerName,
      restartPolicy: target.restartPolicy,
      networkMode: target.networkMode,
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
      envExists,
      composePath: target.composePath,
      envPath: target.envPath,
      envExamplePath: target.envExamplePath,
      reviewSummaryPath: draft.reviewSummaryPath,
      reviewNotesPath: draft.reviewNotesPath
    },
    draft: {
      composeYaml: draft.composeYaml,
      envKeys: draft.envKeys,
      restartPolicy: draft.restartPolicy,
      networkMode: draft.networkMode,
      containerName: draft.containerName
    },
    preservation,
    warnings,
    recommendedSteps: [
      "Confirm the current persistent config path matches the mounted /config source.",
      "Generate the managed draft first so Compose and .env files can be reviewed without stopping the live container.",
      "Compare image, ports, mounts, restart policy, network mode, command, and entrypoint before any cutover.",
      "Only stop and recreate the live container after the managed draft has been reviewed and backed up."
    ]
  };
}
