/**
 * Things only the operator can supply, and what each one breaks.
 *
 * Keelarr configures everything that is not a secret — download clients, root
 * folders, Prowlarr applications, categories, library folders. What is left is
 * credentials it cannot hold: an indexer key, a Usenet account, a Plex token.
 *
 * Reading them back is not an option either. Arr apps mask fields marked
 * `privacy: apiKey`, so an indexer key already configured in Radarr comes back
 * as `***` and cannot be copied into Prowlarr. Detection and a direct link are
 * genuinely the most that can be done here.
 */

/** Where each app keeps the setting, so the link lands on the right page. */
const SETTINGS_PATH = {
  prowlarr: "/settings/indexers",
  radarr: "/settings/indexers",
  sonarr: "/settings/indexers",
  lidarr: "/settings/indexers",
  bazarr: "/settings/languages",
  sabnzbd: "/config/server/",
  tautulli: "/settings",
  // qBittorrent's web interface is a single page; the Web UI options live in
  // its own settings dialog rather than at a routable path.
  qbittorrent: "/",
  jellyfin: "/web/index.html#!/dashboard"
};

export function settingsLinkFor(serviceId, appUrl) {
  const path = SETTINGS_PATH[serviceId];
  return path && appUrl ? `${String(appUrl).replace(/\/+$/, "")}${path}` : appUrl || null;
}

/**
 * An acquiring app has indexers if it has its own, or if Prowlarr has some to
 * sync into it. Reporting Lidarr as lacking indexers when Prowlarr is about to
 * fill them in would be noise; reporting it when Prowlarr is also empty is the
 * whole point.
 */
function acquirerHasIndexers(app, prowlarr) {
  // Null is "could not tell", not "none". Only a real zero is worth reporting.
  if (app?.indexerCount === null || prowlarr?.indexerCount === null) {
    return true;
  }

  return (app?.indexerCount || 0) > 0 || (prowlarr?.indexerCount || 0) > 0;
}

export function findMissingPrerequisites({ apps, services, appUrls = {} }) {
  const missing = [];
  const has = (id) => services.some((service) => service.id === id);
  const prowlarr = apps.get("prowlarr");

  if (has("prowlarr") && prowlarr?.reachable && prowlarr.indexerCount === 0) {
    missing.push({
      serviceId: "prowlarr",
      name: "Prowlarr",
      requirement: "indexer",
      summary: "Prowlarr has no indexers, so it has nothing to sync into the apps connected to it.",
      consequence: "Nothing in this stack can find releases until at least one indexer exists.",
      link: settingsLinkFor("prowlarr", appUrls.prowlarr)
    });
  }

  for (const service of services.filter((entry) => ["radarr", "sonarr", "lidarr"].includes(entry.id))) {
    const app = apps.get(service.id);

    if (!app?.reachable || acquirerHasIndexers(app, prowlarr)) {
      continue;
    }

    missing.push({
      serviceId: service.id,
      name: service.name,
      requirement: "indexer",
      summary: `${service.name} has no indexers${has("prowlarr") ? " and Prowlarr has none to give it" : ""}.`,
      consequence: `${service.name} cannot find anything to download.`,
      link: settingsLinkFor(service.id, appUrls[service.id])
    });
  }

  const downloader = apps.get("sabnzbd");

  if (has("sabnzbd") && downloader && downloader.serverCount === 0) {
    missing.push({
      serviceId: "sabnzbd",
      name: "SABnzbd",
      requirement: "usenet-account",
      summary: "SABnzbd has no Usenet server configured.",
      consequence: "Downloads cannot start, however well the rest of the stack is wired.",
      link: settingsLinkFor("sabnzbd", appUrls.sabnzbd)
    });
  }

  const torrents = apps.get("qbittorrent");

  // Unlike SABnzbd, whose API key Keelarr reads straight out of its config,
  // qBittorrent generates a random admin password on first run and stores only
  // a hash of it. There is nothing to read back, so the operator has to choose
  // one and tell the apps — which is exactly the shape of a prerequisite.
  if (has("qbittorrent") && torrents && torrents.credentialsKnown === false) {
    missing.push({
      serviceId: "qbittorrent",
      name: "qBittorrent",
      requirement: "download-client-credentials",
      summary: "qBittorrent's web interface password is not known to Keelarr.",
      consequence: "Radarr, Sonarr and Lidarr can be pointed at it, but their connection tests will fail until they have the password.",
      link: settingsLinkFor("qbittorrent", appUrls.qbittorrent)
    });
  }

  const mediaServer = apps.get("jellyfin");

  // Jellyfin's API only opens once someone has walked its first-run wizard and
  // created an administrator, so until then there is nothing to wire it into.
  if (has("jellyfin") && mediaServer && mediaServer.setupComplete === false) {
    missing.push({
      serviceId: "jellyfin",
      name: "Jellyfin",
      requirement: "first-run-setup",
      summary: "Jellyfin has not been set up yet — it still needs an administrator account and its libraries.",
      consequence: "It cannot serve anything, and nothing can be connected to it, until that is done.",
      link: settingsLinkFor("jellyfin", appUrls.jellyfin)
    });
  }

  const subtitles = apps.get("bazarr");

  if (has("bazarr") && subtitles?.reachable && subtitles.languageProfiles === 0) {
    missing.push({
      serviceId: "bazarr",
      name: "Bazarr",
      requirement: "language-profile",
      summary: "Bazarr has no language profile, so it does not know which subtitles to look for.",
      // A preference rather than a credential, but it fails the same way: fully
      // wired and unable to do its job until a person decides.
      consequence: "It will not fetch subtitles until at least one language is chosen.",
      link: settingsLinkFor("bazarr", appUrls.bazarr)
    });
  }

  const analytics = apps.get("tautulli");

  if (has("tautulli") && analytics && analytics.plexLinked === false) {
    missing.push({
      serviceId: "tautulli",
      name: "Tautulli",
      requirement: "plex",
      summary: "Tautulli is not connected to a Plex server.",
      consequence: "It has nothing to report on until it is.",
      link: settingsLinkFor("tautulli", appUrls.tautulli)
    });
  }

  return missing;
}
