import { KeelarrError } from "../errors.js";

/**
 * The value an Arr returns in place of a secret it will not disclose.
 *
 * This is why a fetched object cannot simply be copied into a create call: the
 * copy carries the mask, the app stores the mask, and the new client fails
 * every request with 403. Secrets must be supplied from the source we read them
 * from, not round-tripped through the app that is hiding them.
 */
export const MASKED_VALUE = "********";

function findSchema(schemas, implementation) {
  const match = (schemas || []).find(
    (entry) => String(entry?.implementation || "").toLowerCase() === String(implementation).toLowerCase()
  );

  if (!match) {
    throw new KeelarrError(`This app does not offer a ${implementation} integration.`, { statusCode: 422 });
  }

  return match;
}

/**
 * Patches values into the app's own schema template.
 *
 * Only named fields are touched; everything else keeps the app's default, which
 * is how categories, priorities, and sync options stay whatever the app thinks
 * they should be rather than whatever Keelarr was written to assume.
 */
function patchFields(schema, values) {
  return (schema.fields || []).map((field) =>
    Object.hasOwn(values, field.name) ? { ...field, value: values[field.name] } : { ...field }
  );
}

/** The field each app uses to name its download category. */
const CATEGORY_FIELD = {
  radarr: "movieCategory",
  sonarr: "tvCategory",
  lidarr: "musicCategory"
};

/**
 * How each download client identifies itself to an Arr, and what it needs.
 *
 * Usenet and torrent clients are the same idea with different credentials: one
 * authenticates with an API key it writes into its own config, the other with a
 * username and password only the operator knows. The difference is why
 * qBittorrent needs something from you and SABnzbd does not.
 */
export const DOWNLOAD_CLIENTS = Object.freeze({
  sabnzbd: {
    implementation: "Sabnzbd",
    protocol: "usenet",
    credentialFields: ["apiKey"]
  },
  qbittorrent: {
    implementation: "QBittorrent",
    protocol: "torrent",
    credentialFields: ["username", "password"]
  }
});

export function downloadClientKind(serviceId) {
  return DOWNLOAD_CLIENTS[serviceId] || null;
}

export function buildDownloadClientPayload(schemas, { serviceId = "sabnzbd", name, host, port, useSsl = false, ...credentials }) {
  const kind = downloadClientKind(serviceId);

  if (!kind) {
    throw new KeelarrError(`${serviceId} is not a download client Keelarr knows how to register.`, { statusCode: 422 });
  }

  const schema = findSchema(schemas, kind.implementation);
  // Only the credentials this client actually uses. Passing an apiKey to
  // qBittorrent, or a password to SABnzbd, would set a field the app does not
  // have and quietly drop it.
  const supplied = Object.fromEntries(
    kind.credentialFields
      .filter((field) => credentials[field] !== undefined && credentials[field] !== null)
      .map((field) => [field, credentials[field]])
  );

  return {
    ...schema,
    name,
    enable: true,
    fields: patchFields(schema, { host, port, useSsl, ...supplied })
  };
}

/**
 * The body Prowlarr wants for a FlareSolverr proxy.
 *
 * The tag is the part that actually does anything: Prowlarr routes an indexer
 * through a proxy only when the two share a tag, so a proxy with none is
 * configured and idle. Keelarr creates the tag and attaches it here, but which
 * indexers wear it stays the operator's decision — turning it on for all of
 * them would slow down every indexer that never needed it.
 */
export function buildIndexerProxyPayload(schemas, { name = "FlareSolverr", host, requestTimeout = 60, tagIds = [] }) {
  const schema = findSchema(schemas, "FlareSolverr");

  return {
    ...schema,
    name,
    tags: tagIds,
    fields: patchFields(schema, { host, requestTimeout })
  };
}

/**
 * Names a category the app wants that the download client does not have.
 *
 * Blanking it is not a workaround: Lidarr answers an empty category with HTTP
 * 400 and "A category is recommended" — labelled a warning, but it refuses the
 * write all the same. The category has to exist, so the honest move is to say
 * which one is missing rather than produce a client that cannot be saved.
 */
export function missingCategoryFor(schemas, serviceId, availableCategories, clientId = "sabnzbd") {
  const field = CATEGORY_FIELD[serviceId];
  const kind = downloadClientKind(clientId);

  if (!field || !kind || !Array.isArray(availableCategories)) {
    return null;
  }

  const schema = (schemas || []).find(
    (entry) => String(entry?.implementation || "").toLowerCase() === kind.implementation.toLowerCase()
  );
  const wanted = schema?.fields?.find((entry) => entry.name === field)?.value;

  return wanted && !availableCategories.includes(wanted) ? wanted : null;
}

/**
 * The body an app wants for a new library folder.
 *
 * Radarr and Sonarr accept a bare path. Lidarr does not: it requires a name and
 * default quality and metadata profiles, and answers a bare path with four
 * validation errors that all look like separate problems. Profiles are picked
 * from what the app already has rather than invented, since the ids differ per
 * install.
 */
export function buildRootFolderPayload(serviceId, folderPath, { qualityProfiles = [], metadataProfiles = [] } = {}) {
  if (serviceId !== "lidarr") {
    return { payload: { path: folderPath }, missing: null };
  }

  const quality = qualityProfiles.find((entry) => Number(entry?.id) > 0);
  const metadata = metadataProfiles.find((entry) => Number(entry?.id) > 0);

  if (!quality || !metadata) {
    return {
      payload: null,
      missing: `${serviceId} has no ${quality ? "metadata" : "quality"} profile to attach a library folder to yet.`
    };
  }

  return {
    payload: {
      path: folderPath,
      name: folderPath.split("/").filter(Boolean).pop() || "Library",
      defaultQualityProfileId: quality.id,
      defaultMetadataProfileId: metadata.id,
      defaultMonitorOption: "all",
      defaultNewItemMonitorOption: "all",
      defaultTags: []
    },
    missing: null
  };
}

export function buildApplicationPayload(schemas, { implementation, name, prowlarrUrl, baseUrl, apiKey }) {
  const schema = findSchema(schemas, implementation);

  return {
    ...schema,
    name,
    // addOnly rather than fullSync: Prowlarr pushes its indexers into the app
    // but never removes what is already there, so an indexer configured by hand
    // in Radarr survives. Choosing fullSync here would delete it.
    syncLevel: "addOnly",
    fields: patchFields(schema, { prowlarrUrl, baseUrl, apiKey })
  };
}

/**
 * Collapses an app's validation response into one sentence.
 *
 * Arr apps answer a failed test with an array of per-field complaints, and the
 * useful part is usually `detailedDescription` — "Unable to connect to SABnzbd"
 * says far less than the same message with the address it could not reach.
 */
export function describeValidation(payload) {
  if (!Array.isArray(payload)) {
    return null;
  }

  // Only errors block. Arr apps also return advice through this channel —
  // Lidarr answers a blank download category with "A category is recommended"
  // — and refusing to write over a recommendation means a working connection
  // never gets made.
  // `isWarning` is the field to trust. `severity` is not: Lidarr marks its
  // category advice `isWarning: true` and `severity: "error"` at the same time.
  const messages = payload
    .filter((entry) => entry?.isWarning !== true)
    .map((entry) => entry?.detailedDescription || entry?.errorMessage)
    .filter(Boolean);

  return messages.length ? [...new Set(messages)].join("; ") : null;
}

/**
 * The body Seerr wants for a Radarr or Sonarr server.
 *
 * Two of these fields cannot be invented, only discovered: `activeProfileId`
 * and `activeDirectory`. Seerr rejects a server without them, and the only
 * place they exist is the response to its own `/test` call — which is why this
 * takes the test result rather than being buildable from settings alone.
 *
 * Choosing *which* profile is a taste decision with real consequences, and
 * Keelarr does not normally make those. The compromise here is to mirror what
 * Seerr's own UI does — pre-select the first profile the app reports — and to
 * return the choice so the caller can state it in the report rather than let it
 * happen quietly. Changing it afterwards is one dropdown in Seerr.
 *
 * `isDefault` is only ever claimed when nothing else holds it. Seerr clears
 * every other default when it accepts one, so asserting it unconditionally
 * would silently demote a server the operator had chosen.
 */
export function buildSeerrServerPayload(serviceId, {
  appName,
  hostname,
  port,
  apiKey,
  useSsl = false,
  testResult = {},
  existingServers = [],
  preferredDirectory = null
}) {
  const kind = serviceId === "radarr" ? "radarr" : serviceId === "sonarr" ? "sonarr" : null;

  if (!kind) {
    throw new KeelarrError(`${serviceId} is not an app Seerr can be pointed at.`, { statusCode: 422 });
  }

  const profiles = Array.isArray(testResult.profiles) ? testResult.profiles : [];
  const rootFolders = Array.isArray(testResult.rootFolders) ? testResult.rootFolders : [];

  if (profiles.length === 0 || rootFolders.length === 0) {
    return {
      payload: null,
      chosen: null,
      // Said as a chore rather than a fault: both are things Keelarr either has
      // already arranged (the root folder) or cannot decide for you.
      missing: profiles.length === 0
        ? `${appName} has no quality profile yet, so Seerr has nothing to request against.`
        : `${appName} has no root folder yet, so Seerr has nowhere to send what it requests.`
    };
  }

  // Prefer the library folder Keelarr itself configured over whatever happens to
  // be first, so Seerr and the Arr app agree about where media lands.
  const directory = rootFolders.find((folder) => folder?.path === preferredDirectory)?.path
    || rootFolders[0].path;
  const profile = profiles[0];
  const takesDefault = !existingServers.some((server) => server?.is4k !== true && server?.isDefault === true);

  const common = {
    name: appName,
    hostname,
    port: Number(port),
    apiKey,
    useSsl,
    activeProfileId: profile.id,
    activeProfileName: profile.name,
    activeDirectory: directory,
    tags: [],
    is4k: false,
    isDefault: takesDefault,
    // Seerr pulls the app's existing library so it can show what is already
    // available rather than offering to request it again.
    syncEnabled: true,
    preventSearch: false,
    tagRequests: false,
    overrideRule: []
  };

  const payload = kind === "radarr"
    ? { ...common, minimumAvailability: "released" }
    : {
        ...common,
        seriesType: "standard",
        animeSeriesType: "standard",
        enableSeasonFolders: true,
        monitorNewItems: "all"
      };

  return {
    payload,
    chosen: { profileName: profile.name, directory, isDefault: takesDefault },
    missing: null
  };
}

/**
 * The candidate body Seerr's `/test` expects.
 *
 * The same shape as a create, minus everything the test does not read. Kept
 * separate so a test never carries a half-built server Seerr might store.
 */
export function buildSeerrTestPayload({ hostname, port, apiKey, useSsl = false }) {
  return { hostname, port: Number(port), apiKey, useSsl, baseUrl: "" };
}
