const stripTrailingSlash = (value) => value.replace(/\/+$/, "");

export const MANAGED_MODE = Object.freeze({
  /** Generated from the Keelarr catalog. Safe to regenerate at any time. */
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
  "flaresolverr",
  "sabnzbd",
  "qbittorrent",
  "radarr",
  "sonarr",
  "lidarr",
  "bazarr",
  "jellyfin",
  "trailarr",
  "seerr",
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
  seerr: {
    id: "seerr",
    name: "Seerr",
    family: "request",
    description: "Request portal for family and friends. Formerly Jellyseerr, and before that a fork of Overseerr.",
    defaultPort: 5055,
    defaultImage: "ghcr.io/seerr-team/seerr:latest",
    // The project has been renamed twice and most running installs still carry
    // an older name. Adoption matches on the image repository, so without these
    // a container that is plainly Seerr would be reported as unrecognised.
    altImages: ["fallenbagel/jellyseerr", "sctx/overseerr"],
    volumes: ["config"],
    // Not /config. Seerr reads CONFIG_DIRECTORY and defaults to /app/config, and
    // mounting the usual path instead is the single most common way to install
    // it wrong: it starts, works, and loses every setting on the next restart,
    // because the directory it is actually writing to is inside the container.
    configMount: "/app/config",
    // Seerr is not a LinuxServer image. It ignores PUID/PGID and runs as its own
    // node user (UID 1000), so Compose's `user:` is the only lever that works.
    // It has to be pulled, because its config directory lives in the same
    // configRoot as every other app's — left at 1000 it would be the one
    // directory in there the rest of the stack's identity cannot read.
    //
    // Safe to pin here precisely because Seerr mounts no media: it never writes
    // to the library, it only asks Radarr and Sonarr to. So identity governs
    // nothing but its own config, which is why this does not reopen the
    // library-ownership problem docs/architecture.md#identity describes.
    runsAsStackIdentity: true,
    // 200 once set up; 302 to /setup before that, which is still a reachable app.
    healthStatuses: [200, 302, 303, 307],
    buildEnvironment(service) {
      return {
        TZ: "${TZ}",
        // Pinned to the container side of the port mapping rather than ${PORT}.
        // Seerr binds whatever PORT says, so taking it from .env would let an
        // edited host port move the listener away from the port the mapping
        // still targets — the same trap qBittorrent's WEBUI_PORT avoids.
        PORT: String(service.port),
        LOG_LEVEL: "info"
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
  },
  qbittorrent: {
    ...baseLsio(
      "qbittorrent",
      "qBittorrent",
      "Torrent downloader companion for the stack.",
      "lscr.io/linuxserver/qbittorrent:latest",
      // Not qBittorrent's own default of 8080, which SABnzbd already occupies —
      // a stack with both would refuse to start on the second one.
      8090,
      "download"
    ),
    buildEnvironment(service) {
      return {
        PUID: "${PUID}",
        PGID: "${PGID}",
        TZ: "${TZ}",
        // The image binds its web interface to this, so it has to agree with
        // the published port or the container answers on neither.
        WEBUI_PORT: String(service.port)
      };
    }
  },
  flaresolverr: {
    id: "flaresolverr",
    name: "FlareSolverr",
    family: "companion",
    description: "Solves the browser challenges that make some indexers return nothing.",
    defaultPort: 8191,
    defaultImage: "ghcr.io/flaresolverr/flaresolverr:latest",
    // Holds no state at all: it answers a challenge and forgets. Giving it a
    // config directory would create an empty one on every host for no reason.
    volumes: [],
    healthStatuses: [200, 404, 405],
    buildEnvironment() {
      return {
        // Not a LinuxServer image, so no PUID/PGID — it runs as its own user
        // and owns nothing on disk.
        TZ: "${TZ}",
        LOG_LEVEL: "info"
      };
    }
  },
  jellyfin: {
    ...baseLsio(
      "jellyfin",
      "Jellyfin",
      "Media server for watching what the stack collects.",
      "lscr.io/linuxserver/jellyfin:latest",
      8096,
      "media"
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
    rollbackContainerName: override.rollbackContainerName || null,
    // Where a previous removal archived this service's stack files, so a
    // reinstall can restore the service it was rather than a catalog default.
    restoreFrom: override.restoreFrom || null,
    // Opted in to scheduled installs. Off unless said otherwise.
    autoUpdate: override.autoUpdate === true
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
export const SHARED_NETWORK = "keelarr";

export function buildComposeSpec(settings, service) {
  const definition = getServiceDefinition(service.id);
  const composeService = {
    container_name: service.containerName,
    image: service.image,
    restart: service.restartPolicy || "unless-stopped",
    ports: [`${"${PORT}"}:${service.port}`],
    environment: definition.buildEnvironment(service),
    volumes: [],
    networks: [SHARED_NETWORK]
  };

  // For images that ignore PUID/PGID, identity has to be imposed from outside
  // the container. Written through the same ${PUID}/${PGID} that every other
  // stack reads, so one identity setting still governs the whole stack rather
  // than this one service drifting to its image's own default.
  if (definition.runsAsStackIdentity) {
    composeService.user = `${"${PUID}"}:${"${PGID}"}`;
  }

  // Declared rather than assumed: FlareSolverr answers a challenge and forgets,
  // so mounting a config directory for it would create an empty one on every
  // host and imply there was something in there worth backing up.
  if (service.volumes.includes("config")) {
    composeService.volumes.push(`${"${CONFIG_DIR}"}:${definition.configMount || "/config"}`);
  }

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
    // External: Keelarr creates the network once, so no single stack owns it
    // and tearing one stack down cannot remove it from under the others.
    networks: {
      [SHARED_NETWORK]: {
        external: true,
        name: SHARED_NETWORK
      }
    }
  };
}
