const stripTrailingSlash = (value) => value.replace(/\/+$/, "");

export const MANAGED_MODE = Object.freeze({
  /** Generated from the Stackarr catalog. Safe to regenerate at any time. */
  CATALOG: "catalog",
  /** Draft built from a live container, reviewed but not yet cut over. */
  IMPORTED_DRAFT: "imported-draft",
  /** Draft that has been cut over and is now Compose-managed. */
  IMPORTED: "imported"
});

/**
 * Imported stacks are shaped by the live container they came from, so their
 * generated files must never be overwritten with catalog defaults.
 */
export function isImportedMode(mode) {
  return mode === MANAGED_MODE.IMPORTED_DRAFT || mode === MANAGED_MODE.IMPORTED;
}

const baseLsio = (id, name, description, image, defaultPort, family) => ({
  id,
  name,
  family,
  description,
  defaultPort,
  defaultImage: image,
  volumes: ["config", "media"],
  healthStatuses: [200, 301, 302, 303, 401, 403],
  buildEnvironment(service) {
    return {
      PUID: "${PUID}",
      PGID: "${PGID}",
      TZ: "${TZ}"
    };
  }
});

export const SERVICE_ORDER = [
  "prowlarr",
  "sabnzbd",
  "radarr",
  "sonarr",
  "lidarr",
  "readarr",
  "bazarr",
  "trailarr",
  "ombi",
  "tautulli"
];

export const SERVICE_CATALOG = {
  prowlarr: {
    ...baseLsio(
      "prowlarr",
      "Prowlarr",
      "Centralized indexer management for the rest of the stack.",
      "lscr.io/linuxserver/prowlarr:latest",
      9696,
      "core"
    )
  },
  radarr: {
    ...baseLsio(
      "radarr",
      "Radarr",
      "Movie acquisition and library automation.",
      "lscr.io/linuxserver/radarr:latest",
      7878,
      "core"
    )
  },
  sonarr: {
    ...baseLsio(
      "sonarr",
      "Sonarr",
      "TV acquisition and library automation.",
      "lscr.io/linuxserver/sonarr:latest",
      8989,
      "core"
    )
  },
  lidarr: {
    ...baseLsio(
      "lidarr",
      "Lidarr",
      "Music acquisition and library automation.",
      "lscr.io/linuxserver/lidarr:latest",
      8686,
      "core"
    )
  },
  readarr: {
    ...baseLsio(
      "readarr",
      "Readarr",
      "Books and audiobook acquisition automation.",
      "lscr.io/linuxserver/readarr:develop",
      8787,
      "core"
    )
  },
  bazarr: {
    ...baseLsio(
      "bazarr",
      "Bazarr",
      "Subtitle management for Sonarr and Radarr.",
      "lscr.io/linuxserver/bazarr:latest",
      6767,
      "companion"
    )
  },
  trailarr: {
    id: "trailarr",
    name: "Trailarr",
    family: "companion",
    description: "Trailer downloads for Radarr and Sonarr libraries.",
    defaultPort: 7889,
    defaultImage: "nandyalu/trailarr:latest",
    volumes: ["config", "media"],
    healthStatuses: [200, 301, 302, 303, 401, 403],
    buildEnvironment() {
      return {
        PUID: "${PUID}",
        PGID: "${PGID}",
        TZ: "${TZ}"
      };
    }
  },
  ombi: {
    id: "ombi",
    name: "Ombi",
    family: "request",
    description: "Request portal for family and friends.",
    defaultPort: 3579,
    defaultImage: "lscr.io/linuxserver/ombi:latest",
    volumes: ["config"],
    healthStatuses: [200, 301, 302, 303],
    buildEnvironment() {
      return {
        PUID: "${PUID}",
        PGID: "${PGID}",
        TZ: "${TZ}",
        VERSION: "${OMBI_VERSION}"
      };
    }
  },
  tautulli: {
    id: "tautulli",
    name: "Tautulli",
    family: "analytics",
    description: "Plex analytics and health overview.",
    defaultPort: 8181,
    defaultImage: "ghcr.io/tautulli/tautulli:latest",
    volumes: ["config", "plex_logs"],
    healthStatuses: [200, 301, 302, 303],
    buildEnvironment() {
      return {
        PUID: "${PUID}",
        PGID: "${PGID}",
        TZ: "${TZ}"
      };
    }
  },
  sabnzbd: {
    ...baseLsio(
      "sabnzbd",
      "SABnzbd",
      "Usenet downloader companion for the stack.",
      "lscr.io/linuxserver/sabnzbd:latest",
      8080,
      "download"
    )
  }
};

export function listServices() {
  return SERVICE_ORDER.map((id) => SERVICE_CATALOG[id]);
}

export function getServiceDefinition(id) {
  return SERVICE_CATALOG[id];
}

export function buildServiceFromCatalog(baseSettings, id, override = {}) {
  const definition = getServiceDefinition(id);

  if (!definition) {
    throw new Error(`Unknown service: ${id}`);
  }

  const stackDir = `${stripTrailingSlash(baseSettings.stackRoot)}/${id}`;
  const configDir = `${stripTrailingSlash(baseSettings.configRoot)}/${id}/config`;
  const publicHost = stripTrailingSlash(baseSettings.hostUrl);
  const service = {
    id,
    enabled: true,
    name: definition.name,
    family: definition.family,
    description: definition.description,
    image: override.image || definition.defaultImage,
    port: override.port || definition.defaultPort,
    stackDir,
    composePath: `${stackDir}/compose.yml`,
    envPath: `${stackDir}/.env`,
    envExamplePath: `${stackDir}/.env.example`,
    containerName: override.containerName || id,
    configDir,
    mediaDir: baseSettings.mediaRoot,
    downloadsDir: baseSettings.downloadsRoot,
    plexLogsDir: baseSettings.plexLogsRoot,
    appUrl: `${publicHost}:${override.port || definition.defaultPort}`,
    healthStatuses: definition.healthStatuses,
    volumes: definition.volumes,
    managedMode: override.mode || "catalog",
    restartPolicy: override.restartPolicy || "unless-stopped",
    networkMode: override.networkMode || "default",
    envKeys: override.envKeys || [],
    sourceContainerId: override.sourceContainerId || null,
    sourceContainerName: override.sourceContainerName || null,
    sourceImage: override.sourceImage || null,
    reviewSummaryPath: override.reviewSummaryPath || null,
    reviewNotesPath: override.reviewNotesPath || null,
    importedAt: override.importedAt || null,
    cutoverAt: override.cutoverAt || null,
    // Present only while a preserved pre-cutover container still exists, so
    // the dashboard knows whether revert is available.
    rollbackContainerName: override.rollbackContainerName || null
  };

  return service;
}

export function buildServicesFromSelection(baseSettings, selectedServiceIds, serviceOverrides = {}) {
  const selected = new Set(selectedServiceIds);
  const services = {};

  for (const id of SERVICE_ORDER) {
    if (!selected.has(id)) {
      continue;
    }

    services[id] = buildServiceFromCatalog(baseSettings, id, serviceOverrides[id] || {});
  }

  return services;
}

/**
 * Every catalog stack is its own Compose project, so by default each service
 * lands on an isolated <project>_default network and cannot reach the others.
 * Joining one shared network lets them resolve each other by container name —
 * which is exactly how Prowlarr, the Arr apps, and a download client expect to
 * talk to each other.
 */
export const SHARED_NETWORK = "stackarr";

export function buildComposeSpec(settings, service) {
  const definition = getServiceDefinition(service.id);
  const composeService = {
    container_name: service.containerName,
    image: service.image,
    restart: service.restartPolicy || "unless-stopped",
    ports: [`${"${PORT}"}:${service.port}`],
    environment: definition.buildEnvironment(service),
    volumes: [`${"${CONFIG_DIR}"}:/config`],
    networks: [SHARED_NETWORK]
  };

  if (service.volumes.includes("media")) {
    composeService.volumes.push(`${"${MEDIA_DIR}"}:/Media`);
  }

  if (service.volumes.includes("plex_logs")) {
    composeService.volumes.push(`${"${PLEX_LOGS_DIR}"}:/plex_logs:ro`);
  }

  return {
    name: service.id,
    services: {
      [service.id]: composeService
    },
    // External: Stackarr creates the network once, so no single stack owns it
    // and tearing one stack down cannot remove it from under the others.
    networks: {
      [SHARED_NETWORK]: {
        external: true,
        name: SHARED_NETWORK
      }
    }
  };
}
