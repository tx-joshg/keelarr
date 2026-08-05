import { pathExists } from "./host-adapters/shared.js";
import { runCommand } from "./command-runner.js";
import { SERVICE_CATALOG } from "./service-catalog.js";

const EXPECTED_MOUNT_TARGETS = {
  config: "/config",
  media: "/Media",
  plex_logs: "/plex_logs"
};

export function normalizeImageRepository(image = "") {
  const trimmed = image.trim();
  if (!trimmed) {
    return "";
  }

  const withoutDigest = trimmed.split("@")[0];
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  const withoutTag = lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
  const segments = withoutTag.split("/");

  if (segments.length > 1 && (segments[0].includes(".") || segments[0].includes(":") || segments[0] === "localhost")) {
    return segments.slice(1).join("/");
  }

  return withoutTag;
}

function sanitizeContainerName(name = "") {
  return name.replace(/^\//, "");
}

function parseEnvKeys(env = []) {
  return [...new Set(env
    .map((entry) => entry.split("=")[0])
    .filter(Boolean))].sort();
}

function parseEnvironment(env = []) {
  const entries = {};

  for (const item of env) {
    const index = item.indexOf("=");
    const key = index === -1 ? item : item.slice(0, index);
    const value = index === -1 ? "" : item.slice(index + 1);

    if (!key) {
      continue;
    }

    entries[key] = value;
  }

  return entries;
}

export function diffEnvironment(containerEnvironment = {}, imageEnvironment = {}) {
  const entries = {};

  for (const [key, value] of Object.entries(containerEnvironment)) {
    if (!key) {
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(imageEnvironment, key) && imageEnvironment[key] === value) {
      continue;
    }

    entries[key] = value;
  }

  return entries;
}

function parsePorts(inspect) {
  const networkMode = inspect.HostConfig?.NetworkMode || "default";
  const published = inspect.NetworkSettings?.Ports || {};
  const ports = [];

  for (const [containerPort, bindings] of Object.entries(published)) {
    if (!bindings || bindings.length === 0) {
      ports.push({
        containerPort,
        hostIp: null,
        hostPort: null,
        display: networkMode === "host" ? `${containerPort} (host network)` : containerPort
      });
      continue;
    }

    for (const binding of bindings) {
      ports.push({
        containerPort,
        hostIp: binding.HostIp || null,
        hostPort: binding.HostPort || null,
        display: `${binding.HostIp || "0.0.0.0"}:${binding.HostPort}->${containerPort}`
      });
    }
  }

  if (ports.length === 0 && networkMode === "host") {
    return Object.keys(inspect.Config?.ExposedPorts || {}).map((containerPort) => ({
      containerPort,
      hostIp: null,
      hostPort: null,
      display: `${containerPort} (host network)`
    }));
  }

  return ports;
}

function parseMounts(inspect) {
  return (inspect.Mounts || []).map((mount) => ({
    type: mount.Type,
    source: mount.Source,
    target: mount.Destination,
    mode: mount.RW === false ? "ro" : "rw",
    name: mount.Name || null
  }));
}

function parseNetworks(inspect) {
  return Object.entries(inspect.NetworkSettings?.Networks || {}).map(([name, network]) => ({
    name,
    address: network?.IPAddress || null
  }));
}

export function matchSupportedService(inspect) {
  const containerName = sanitizeContainerName(inspect.Name || "");
  if (SERVICE_CATALOG[containerName]) {
    return {
      serviceId: SERVICE_CATALOG[containerName].id,
      serviceName: SERVICE_CATALOG[containerName].name,
      matchedBy: "name",
      definition: SERVICE_CATALOG[containerName]
    };
  }

  const imageRepository = normalizeImageRepository(inspect.Config?.Image || "");
  const definition = Object.values(SERVICE_CATALOG).find(
    (candidate) => normalizeImageRepository(candidate.defaultImage) === imageRepository
  );

  if (!definition) {
    return null;
  }

  return {
    serviceId: definition.id,
    serviceName: definition.name,
    matchedBy: "image",
    definition
  };
}

export async function buildAdoptionIssues(serviceMatch, inspect, mounts) {
  const issues = [];

  if (!serviceMatch) {
    issues.push({
      level: "warn",
      message: "Container is not currently mapped to a Stackarr-supported service."
    });
    return issues;
  }

  for (const volumeKey of serviceMatch.definition.volumes || []) {
    const target = EXPECTED_MOUNT_TARGETS[volumeKey];
    const mount = mounts.find((candidate) => candidate.target === target);
    const level = volumeKey === "plex_logs" ? "warn" : "error";

    if (!mount) {
      issues.push({
        level,
        message: `Missing expected ${target} mount for ${serviceMatch.serviceName}.`
      });
      continue;
    }

    if (mount.type === "bind" && !(await pathExists(mount.source))) {
      issues.push({
        level,
        message: `Mount source does not exist on disk: ${mount.source}`
      });
    }
  }

  if (inspect.Config?.Image && inspect.Config.Image !== serviceMatch.definition.defaultImage) {
    issues.push({
      level: "info",
      message: `Image differs from the current Stackarr default: ${inspect.Config.Image}`
    });
  }

  if (inspect.HostConfig?.NetworkMode === "host") {
    issues.push({
      level: "info",
      message: "Host networking is enabled, so published ports are inferred from exposed ports."
    });
  }

  return issues;
}

async function buildInventoryItem(inspect, options = {}) {
  const serviceMatch = matchSupportedService(inspect);
  const mounts = parseMounts(inspect);
  const issues = await buildAdoptionIssues(serviceMatch, inspect, mounts);
  const environment = diffEnvironment(
    parseEnvironment(inspect.Config?.Env || []),
    options.imageEnvironmentByRef?.get(inspect.Config?.Image || "") || {}
  );

  const item = {
    containerId: inspect.Id?.slice(0, 12) || null,
    containerName: sanitizeContainerName(inspect.Name || ""),
    image: inspect.Config?.Image || "",
    imageId: inspect.Image || null,
    recognized: Boolean(serviceMatch),
    serviceId: serviceMatch?.serviceId || null,
    serviceName: serviceMatch?.serviceName || null,
    matchedBy: serviceMatch?.matchedBy || null,
    status: inspect.State?.Status || "unknown",
    healthStatus: inspect.State?.Health?.Status || null,
    restartPolicy: inspect.HostConfig?.RestartPolicy?.Name || "no",
    networkMode: inspect.HostConfig?.NetworkMode || "default",
    networks: parseNetworks(inspect),
    ports: parsePorts(inspect),
    mounts,
    envKeys: Object.keys(environment).sort(),
    command: inspect.Config?.Cmd || [],
    entrypoint: inspect.Config?.Entrypoint || [],
    issues,
    adoptable: Boolean(serviceMatch) && !issues.some((issue) => issue.level === "error")
  };

  if (options.includeSensitive === true) {
    item.environment = environment;
  }

  return item;
}

async function loadContainerInventory(dockerBin, options = {}) {
  const idsResult = await runCommand(dockerBin, ["ps", "--filter", "status=running", "-aq"], {
    logger: options.logger
  });
  if (!idsResult.ok) {
    throw new Error(idsResult.stderr || idsResult.stdout || "Unable to list Docker containers.");
  }

  const containerIds = idsResult.stdout
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (containerIds.length === 0) {
    return [];
  }

  const inspectResult = await runCommand(dockerBin, ["inspect", ...containerIds], {
    logger: options.logger
  });
  if (!inspectResult.ok) {
    throw new Error(inspectResult.stderr || inspectResult.stdout || "Unable to inspect Docker containers.");
  }

  return JSON.parse(inspectResult.stdout || "[]");
}

async function loadImageEnvironmentByRef(dockerBin, inventory, options = {}) {
  const imageRefs = [...new Set(inventory
    .map((inspect) => inspect.Config?.Image || "")
    .filter(Boolean))];

  if (!imageRefs.length) {
    return new Map();
  }

  const inspectResult = await runCommand(dockerBin, ["image", "inspect", ...imageRefs], {
    logger: options.logger
  });

  if (!inspectResult.ok) {
    return new Map();
  }

  const inspectedImages = JSON.parse(inspectResult.stdout || "[]");
  const environmentByRef = new Map();

  inspectedImages.forEach((imageInspect, index) => {
    const defaults = parseEnvironment(imageInspect?.Config?.Env || []);
    const requestedRef = imageRefs[index];

    if (requestedRef) {
      environmentByRef.set(requestedRef, defaults);
    }

    for (const tag of imageInspect?.RepoTags || []) {
      environmentByRef.set(tag, defaults);
    }

    for (const digest of imageInspect?.RepoDigests || []) {
      environmentByRef.set(digest, defaults);
    }
  });

  return environmentByRef;
}

export function shouldIncludeInventoryItem(item) {
  if (!item?.containerName) {
    return false;
  }

  if (item.containerName === "stackarr") {
    return false;
  }

  return item.status === "running";
}

export async function scanDockerInventory(settings, options = {}) {
  const inventory = await loadContainerInventory(settings.dockerBin, options);
  const imageEnvironmentByRef = await loadImageEnvironmentByRef(settings.dockerBin, inventory, options);
  const items = await Promise.all(inventory.map((inspect) => buildInventoryItem(inspect, {
    ...options,
    imageEnvironmentByRef
  })));
  const visibleItems = items.filter((item) => shouldIncludeInventoryItem(item));
  const sortedItems = [...visibleItems].sort((left, right) => {
    if (left.recognized !== right.recognized) {
      return left.recognized ? -1 : 1;
    }

    return left.containerName.localeCompare(right.containerName);
  });

  return {
    ok: true,
    scannedAt: new Date().toISOString(),
    summary: {
      totalContainers: sortedItems.length,
      recognized: sortedItems.filter((item) => item.recognized).length,
      adoptable: sortedItems.filter((item) => item.adoptable).length,
      needsReview: sortedItems.filter((item) => item.issues.some((issue) => issue.level !== "info")).length
    },
    items: sortedItems
  };
}
