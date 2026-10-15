import { SERVICE_CATALOG, SERVICE_ORDER, getServiceDefinition } from "./service-catalog.js";
import { normalizeImageRepository } from "./import-scanner.js";

/**
 * What a selection of apps will and will not do, before any of it is installed.
 *
 * Keelarr already tells an operator what is wrong *after* a stack is running —
 * a missing download client, a Bazarr with no language profile. This answers the
 * same class of question one step earlier, while the apps are still a list of
 * checkboxes, where the fix costs nothing.
 *
 * The line this module tries hard to hold: it refuses almost nothing. A homelab
 * tool that second-guesses its operator is worse than one that says its piece
 * and gets out of the way, and most "wrong" combinations here are somebody
 * mid-migration who knows exactly what they are doing. Only an arrangement that
 * genuinely cannot start is blocked.
 */
export const COMPATIBILITY_SEVERITY = Object.freeze({
  /** Cannot run as described. The only severity that refuses a selection. */
  BLOCKED: "blocked",
  /** Runs, but two choices work against each other. Acknowledged, not fixed. */
  CONFLICT: "conflict",
  /** Runs. Worth knowing before rather than after. */
  ADVICE: "advice"
});

/** Apps that acquire releases, and therefore need somewhere to send them. */
const ACQUIRERS = ["radarr", "sonarr", "lidarr"];
const DOWNLOAD_CLIENTS = ["sabnzbd", "qbittorrent"];

/**
 * Media servers Seerr can authenticate against, by image repository.
 *
 * Needed because a running Plex is invisible to the catalog — Keelarr does not
 * manage Plex, so the adoption scan reports it as unrecognised. Without this,
 * an operator with a perfectly good Plex would be told Seerr has nothing to
 * sign in against.
 */
const MEDIA_SERVER_IMAGES = [
  "plexinc/pms-docker",
  "linuxserver/plex",
  "emby/embyserver",
  "linuxserver/emby",
  "jellyfin/jellyfin",
  "linuxserver/jellyfin"
];

/**
 * Media servers found running on the host that Keelarr does not manage.
 *
 * Takes the raw scan items rather than the recognised ones, precisely because
 * the interesting case is the app the catalog has no entry for.
 */
export function detectMediaServers(scanItems = []) {
  const found = new Set();

  for (const item of scanItems) {
    const repository = normalizeImageRepository(item?.image || "");

    if (MEDIA_SERVER_IMAGES.some((candidate) => normalizeImageRepository(candidate) === repository)) {
      found.add(repository);
    }
  }

  return [...found];
}

/**
 * The port each selected app will actually publish.
 *
 * Overrides first, catalog default second — the same precedence
 * `buildServiceFromCatalog` uses, because a collision has to be judged on the
 * ports the Compose files will really carry.
 */
export function resolvePorts(selectedServiceIds = [], serviceOverrides = {}) {
  return selectedServiceIds
    .filter((id) => SERVICE_CATALOG[id])
    .map((id) => ({
      serviceId: id,
      name: SERVICE_CATALOG[id].name,
      port: Number(serviceOverrides?.[id]?.port || SERVICE_CATALOG[id].defaultPort)
    }));
}

const nameOf = (id) => getServiceDefinition(id)?.name || id;
const listNames = (ids) => ids.map(nameOf).join(" or ");

/**
 * Every rule, in the order the UI should present them.
 *
 * Each returns null when it has nothing to say. Keeping them as a flat list of
 * small functions rather than a class hierarchy is deliberate: a rule is one
 * question about one selection, and the whole value of the module is that you
 * can read any single rule in isolation and judge whether it is true.
 */
const RULES = [
  {
    id: "port-collision",
    severity: COMPATIBILITY_SEVERITY.BLOCKED,
    evaluate: ({ ports }) => {
      const byPort = new Map();

      for (const entry of ports) {
        byPort.set(entry.port, [...(byPort.get(entry.port) || []), entry]);
      }

      return [...byPort.entries()]
        .filter(([, entries]) => entries.length > 1)
        .map(([port, entries]) => ({
          subjects: entries.map((entry) => entry.serviceId),
          summary: `${entries.map((entry) => entry.name).join(" and ")} are both set to port ${port}.`,
          // Not a preference. The second container to start fails to bind and
          // Compose stops, so this is the one thing worth refusing outright.
          consequence: "Whichever starts second cannot bind the port, so it will not start at all.",
          remedy: `Give one of them a different port.`
        }));
    }
  },
  {
    id: "two-request-portals",
    severity: COMPATIBILITY_SEVERITY.CONFLICT,
    evaluate: ({ has }) => {
      if (!has("seerr") || !has("ombi")) {
        return [];
      }

      return [{
        subjects: ["seerr", "ombi"],
        summary: "Seerr and Ombi are the same job: a request portal in front of Radarr and Sonarr.",
        // Worth stating precisely, because the failure is not obvious. Both
        // write into the same Arr apps, so the same film requested in both
        // arrives twice and each portal believes it is the one tracking it.
        consequence: "Both will send requests to the same apps, and neither knows what the other has already asked for.",
        remedy: "Pick one. Running both briefly is reasonable while you migrate — this is worth knowing, not worth stopping."
      }];
    }
  },
  {
    id: "seerr-without-media-server",
    severity: COMPATIBILITY_SEVERITY.CONFLICT,
    evaluate: ({ has, mediaServers }) => {
      if (!has("seerr") || has("jellyfin") || mediaServers.length > 0) {
        return [];
      }

      return [{
        subjects: ["seerr"],
        summary: "Seerr has no media server to sign in against.",
        // Verified against Seerr's own auth middleware: its API key resolves to
        // the administrator the setup wizard creates, and the wizard will not
        // complete without a media server. So this is not a degraded Seerr, it
        // is a Seerr permanently stuck on its first screen — and Keelarr cannot
        // wire it either, because the API refuses everything until that user
        // exists.
        consequence: "It will sit on its setup screen, and Keelarr cannot connect it to anything until the wizard is finished.",
        remedy: "Add Jellyfin, or point Seerr at a Plex, Emby or Jellyfin you already run."
      }];
    }
  },
  {
    id: "tautulli-is-plex-only",
    severity: COMPATIBILITY_SEVERITY.ADVICE,
    evaluate: ({ has, mediaServers }) => {
      if (!has("tautulli") || mediaServers.some((image) => image.includes("plex"))) {
        return [];
      }

      return [{
        subjects: ["tautulli"],
        summary: "Tautulli only reports on Plex, and no Plex was found.",
        consequence: has("jellyfin")
          ? "It cannot read anything from Jellyfin, so it will install and sit idle."
          : "It will install and have nothing to report on.",
        remedy: "Leave it out unless you also run Plex."
      }];
    }
  },
  {
    id: "ombi-on-a-jellyfin-stack",
    severity: COMPATIBILITY_SEVERITY.ADVICE,
    evaluate: ({ has }) => {
      if (!has("ombi") || !has("jellyfin") || has("seerr")) {
        return [];
      }

      return [{
        subjects: ["ombi"],
        summary: "Seerr is the request portal built for Jellyfin.",
        // Carefully not a claim that Ombi cannot do this — it supports Jellyfin
        // and Emby too. The honest difference is that Keelarr wires Seerr for
        // you and cannot wire Ombi at all.
        consequence: "Ombi works with Jellyfin, but Keelarr can wire Seerr into Radarr and Sonarr automatically and cannot do that for Ombi.",
        remedy: "Consider Seerr instead, unless you already have Ombi set up the way you want it."
      }];
    }
  },
  {
    id: "acquirer-without-download-client",
    severity: COMPATIBILITY_SEVERITY.ADVICE,
    evaluate: ({ has, selected }) => {
      const acquirers = selected.filter((id) => ACQUIRERS.includes(id));

      if (acquirers.length === 0 || DOWNLOAD_CLIENTS.some(has)) {
        return [];
      }

      return [{
        subjects: acquirers,
        summary: `${acquirers.map(nameOf).join(", ")} ${acquirers.length === 1 ? "has" : "have"} no download client.`,
        consequence: acquirers.length === 1
          ? "It can find releases and will have nothing to fetch them with."
          : "They can find releases and will have nothing to fetch them with.",
        remedy: `Add ${listNames(DOWNLOAD_CLIENTS)}.`
      }];
    }
  },
  {
    id: "download-client-without-acquirer",
    severity: COMPATIBILITY_SEVERITY.ADVICE,
    evaluate: ({ has, selected }) => {
      const clients = selected.filter((id) => DOWNLOAD_CLIENTS.includes(id));

      if (clients.length === 0 || ACQUIRERS.some(has)) {
        return [];
      }

      return [{
        subjects: clients,
        summary: `${clients.map(nameOf).join(" and ")} ${clients.length === 1 ? "has" : "have"} nothing asking for downloads.`,
        consequence: "Nothing in this stack will send them anything to fetch.",
        remedy: `Add ${listNames(ACQUIRERS)}.`
      }];
    }
  },
  {
    id: "acquirer-without-prowlarr",
    severity: COMPATIBILITY_SEVERITY.ADVICE,
    evaluate: ({ has, selected }) => {
      const acquirers = selected.filter((id) => ACQUIRERS.includes(id));

      if (acquirers.length === 0 || has("prowlarr")) {
        return [];
      }

      return [{
        subjects: acquirers,
        summary: `${acquirers.map(nameOf).join(", ")} will start with no indexers.`,
        consequence: "Without Prowlarr you add and maintain indexers separately in each app by hand.",
        remedy: "Add Prowlarr and it manages indexers for all of them at once."
      }];
    }
  },
  {
    id: "bazarr-without-library-apps",
    severity: COMPATIBILITY_SEVERITY.ADVICE,
    evaluate: ({ has }) => {
      if (!has("bazarr") || has("radarr") || has("sonarr")) {
        return [];
      }

      return [{
        subjects: ["bazarr"],
        summary: "Bazarr has nothing to fetch subtitles for.",
        consequence: "It only looks at libraries Radarr and Sonarr tell it about.",
        remedy: "Add Radarr or Sonarr."
      }];
    }
  },
  {
    id: "trailarr-without-library-apps",
    severity: COMPATIBILITY_SEVERITY.ADVICE,
    evaluate: ({ has }) => {
      if (!has("trailarr") || has("radarr") || has("sonarr")) {
        return [];
      }

      return [{
        subjects: ["trailarr"],
        summary: "Trailarr has no library to pull trailers for.",
        consequence: "It reads what Radarr and Sonarr have collected.",
        remedy: "Add Radarr or Sonarr."
      }];
    }
  },
  {
    id: "flaresolverr-without-prowlarr",
    severity: COMPATIBILITY_SEVERITY.ADVICE,
    evaluate: ({ has }) => {
      if (!has("flaresolverr") || has("prowlarr")) {
        return [];
      }

      return [{
        subjects: ["flaresolverr"],
        summary: "FlareSolverr is only wired in as Prowlarr's challenge solver.",
        consequence: "On its own it will run and never be asked anything.",
        remedy: "Add Prowlarr, or leave FlareSolverr out."
      }];
    }
  }
];

/**
 * Judges a selection.
 *
 * `discovered` is the adoption scan's raw items, used only to notice apps
 * Keelarr does not manage — a Plex that makes Tautulli sensible, a Jellyfin
 * that makes Seerr workable. Omitting it makes the rules more cautious, never
 * less: they will advise about things the host may already have.
 */
export function evaluateCompatibility({
  selectedServiceIds = [],
  serviceOverrides = {},
  discovered = []
} = {}) {
  const selected = SERVICE_ORDER.filter((id) => selectedServiceIds.includes(id));
  const selectedSet = new Set(selected);
  const context = {
    selected,
    has: (id) => selectedSet.has(id),
    ports: resolvePorts(selected, serviceOverrides),
    mediaServers: detectMediaServers(discovered)
  };

  const findings = RULES.flatMap((rule) =>
    rule.evaluate(context).map((finding) => ({ id: rule.id, severity: rule.severity, ...finding }))
  );

  const bySeverity = (severity) => findings.filter((finding) => finding.severity === severity);
  const blocked = bySeverity(COMPATIBILITY_SEVERITY.BLOCKED);

  return {
    // The only question a caller has to act on. Everything else is reporting.
    ok: blocked.length === 0,
    blocked,
    conflicts: bySeverity(COMPATIBILITY_SEVERITY.CONFLICT),
    advice: bySeverity(COMPATIBILITY_SEVERITY.ADVICE),
    findings
  };
}

/**
 * One sentence naming why a selection was refused.
 *
 * Only blocked findings reach this: a conflict is the operator's call, and
 * turning one into an error message would be exactly the nannying this module
 * is trying not to do.
 */
export function summarizeBlocked(blocked = []) {
  return blocked.map((finding) => `${finding.summary} ${finding.consequence}`).join(" ");
}
