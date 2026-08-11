/**
 * Which API version each app speaks. Getting this wrong produces a 404 that
 * looks exactly like an unreachable app, so it is data rather than a guess.
 */
export const API_VERSION = Object.freeze({
  radarr: "v3",
  sonarr: "v3",
  lidarr: "v1",
  prowlarr: "v1"
});

/**
 * Longer than the dashboard's liveness probe on purpose. That probe wants a
 * fast answer about whether an app is up; these calls make an app do real work
 * — a connection test reaches out to a third service and waits on it.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

export function speaksArrApi(serviceId) {
  return Boolean(API_VERSION[serviceId]);
}

/**
 * Arr validation failures echo the submitted object back in the response body,
 * API key field and all. Keeping only the two fields that describe the problem
 * stops that body from reaching a job snapshot or an error message.
 */
function scrubValidationErrors(payload) {
  if (!Array.isArray(payload)) {
    return null;
  }

  return payload
    .map((entry) => ({
      propertyName: entry?.propertyName || null,
      errorMessage: entry?.errorMessage || null
    }))
    .filter((entry) => entry.errorMessage);
}

function describeFailure(status, payload) {
  const validation = scrubValidationErrors(payload);

  if (validation?.length) {
    return validation.map((entry) => [entry.propertyName, entry.errorMessage].filter(Boolean).join(": ")).join("; ");
  }

  if (status === 401) {
    return "The app rejected the API key.";
  }

  if (status === 404) {
    return "The app does not offer that endpoint.";
  }

  return `The app answered ${status}.`;
}

/**
 * One request to an Arr-family API.
 *
 * Returns a result rather than throwing, so a single unreachable app degrades
 * one row of the wiring check instead of aborting the whole thing. The key goes
 * in a header, never a query string, and never appears in a returned message.
 */
export async function arrRequest(baseUrl, apiKey, { method = "GET", path, body = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, "")}${path}`;

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "X-Api-Key": apiKey,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });

    const text = await response.text();
    let payload = null;

    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      return { ok: false, status: response.status, data: null, error: describeFailure(response.status, payload) };
    }

    return { ok: true, status: response.status, data: payload, error: null };
  } catch (error) {
    // AbortSignal.timeout surfaces as TimeoutError; say so in plain words.
    const reason = error.name === "TimeoutError" ? `No answer within ${timeoutMs / 1000}s.` : error.message;
    return { ok: false, status: null, data: null, error: reason };
  }
}

function api(serviceId, resource) {
  return `/api/${API_VERSION[serviceId]}/${resource}`;
}

/**
 * SABnzbd's API, which is shaped nothing like the Arr apps'.
 *
 * Everything is one endpoint driven by a `mode` parameter, and the key is a
 * parameter rather than a header. It is sent in a POST body rather than a query
 * string on purpose: a key in a URL ends up in the app's own access log, and
 * SABnzbd accepts either.
 */
export async function sabnzbdRequest(baseUrl, apiKey, params, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const body = new URLSearchParams({ ...params, output: "json", apikey: apiKey });

  try {
    const response = await fetch(`${String(baseUrl).replace(/\/+$/, "")}/api`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      return { ok: false, data: null, error: `SABnzbd answered ${response.status}.` };
    }

    const payload = await response.json();

    // SABnzbd reports failure in the body with a 200 status.
    return payload?.status === false
      ? { ok: false, data: null, error: payload.error || "SABnzbd rejected the request." }
      : { ok: true, data: payload, error: null };
  } catch (error) {
    const reason = error.name === "TimeoutError" ? `No answer within ${timeoutMs / 1000}s.` : error.message;
    return { ok: false, data: null, error: reason };
  }
}

export const sabnzbdApi = {
  /** Counted, never read: these are the operator's paid Usenet credentials. */
  countServers: async (base, key) => {
    const result = await sabnzbdRequest(base, key, { mode: "get_config", section: "servers" });
    return result.ok
      ? { ok: true, data: (result.data?.config?.servers || []).length, error: null }
      : result;
  },

  listCategories: async (base, key) => {
    const result = await sabnzbdRequest(base, key, { mode: "get_config", section: "categories" });
    return result.ok
      ? { ok: true, data: (result.data?.config?.categories || []).map((entry) => entry.name), error: null }
      : result;
  },

  /**
   * Adds a category, mirroring how the existing ones are set up: a folder of
   * the same name under the completed-downloads directory, which is what keeps
   * each app's downloads separated.
   */
  createCategory: (base, key, name) =>
    sabnzbdRequest(base, key, {
      mode: "set_config",
      section: "categories",
      keyword: name,
      name,
      dir: name,
      script: "Default",
      priority: "-100"
    })
};

/**
 * Bazarr's API, which is settings-shaped rather than resource-shaped.
 *
 * The Arr apps expose collections you POST a new item to. Bazarr has one
 * settings document you patch, and it type-checks what it is given: sending the
 * string "False" for a boolean is answered with 406 and a complaint naming the
 * expected type. So values go over as JSON, where a boolean stays a boolean.
 */
export const bazarrApi = {
  systemStatus: (base, key) => bazarrRequest(base, key, "/api/system/status"),
  getSettings: (base, key) => bazarrRequest(base, key, "/api/system/settings"),
  getLanguageProfiles: async (base, key) => {
    const result = await bazarrRequest(base, key, "/api/system/languages/profiles");
    return result.ok ? { ok: true, data: Array.isArray(result.data) ? result.data : [], error: null } : result;
  },
  /**
   * Writes settings the way Bazarr's own UI does: form-encoded keys named
   * `settings-<section>-<field>`.
   *
   * Nested JSON is accepted with 204 and silently ignored — verified against a
   * live instance, where the values came back unchanged. Since a 204 means
   * nothing either way, callers must read back rather than trust the status.
   *
   * Generous timeout: enabling a link makes Bazarr reach out to that app, and
   * the request does not return until it has.
   */
  updateSettings: (base, key, params) =>
    bazarrRequest(base, key, "/api/system/settings", {
      method: "POST",
      form: params,
      timeoutMs: 90_000
    })
};

async function bazarrRequest(baseUrl, apiKey, path, { method = "GET", form = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const response = await fetch(`${String(baseUrl).replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        "X-API-KEY": apiKey,
        Accept: "application/json",
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {})
      },
      body: form ? new URLSearchParams(form) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });

    const text = await response.text();

    if (!response.ok) {
      // Its validation errors name the field and the expected type, which is
      // more use than the status alone.
      return { ok: false, data: null, error: text.trim().slice(0, 200) || `Bazarr answered ${response.status}.` };
    }

    return { ok: true, data: text ? JSON.parse(text) : null, error: null };
  } catch (error) {
    const reason = error.name === "TimeoutError" ? `No answer within ${timeoutMs / 1000}s.` : error.message;
    return { ok: false, data: null, error: reason };
  }
}

/**
 * The read-only surface the wiring check needs.
 *
 * `testall` is included despite being a POST: it runs each app's own connection
 * tests against what is already configured and changes nothing. That is what
 * lets a read-only check report whether existing wiring actually works, rather
 * than only whether it looks plausible.
 *
 * SABnzbd's own surface is separate, above, because its API is shaped nothing
 * like these.
 */
export const arrApi = {
  systemStatus: (serviceId, base, key) => arrRequest(base, key, { path: api(serviceId, "system/status") }),
  listDownloadClients: (serviceId, base, key) => arrRequest(base, key, { path: api(serviceId, "downloadclient") }),
  listRootFolders: (serviceId, base, key) => arrRequest(base, key, { path: api(serviceId, "rootfolder") }),
  listRemotePathMappings: (serviceId, base, key) =>
    arrRequest(base, key, { path: api(serviceId, "remotepathmapping") }),
  listApplications: (base, key) => arrRequest(base, key, { path: "/api/v1/applications" }),
  // Only ever counted. Indexers carry paid credentials, so Stackarr reads
  // whether any exist and never touches them.
  listIndexers: (serviceId, base, key) => arrRequest(base, key, { path: api(serviceId, "indexer") }),
  testAllDownloadClients: (serviceId, base, key) =>
    arrRequest(base, key, { method: "POST", path: api(serviceId, "downloadclient/testall") }),
  testAllApplications: (base, key) => arrRequest(base, key, { method: "POST", path: "/api/v1/applications/testall" }),

  // --- writes ---
  //
  // The schema endpoints matter: an app's field list changes between versions,
  // so payloads are built by patching values into the template the app itself
  // hands out rather than from a list written here.
  downloadClientSchema: (serviceId, base, key) => arrRequest(base, key, { path: api(serviceId, "downloadclient/schema") }),
  applicationSchema: (base, key) => arrRequest(base, key, { path: "/api/v1/applications/schema" }),

  // Test endpoints take a full candidate body rather than an id, so a payload
  // can be checked before it is written. Note that Arr apps validate on save
  // anyway — these calls exist to fail early with a clearer message, not to
  // substitute for that.
  testDownloadClient: (serviceId, base, key, body) =>
    // Generous: the app is making its own network round trip to a third
    // service, and a slow answer is not the same as a wrong one.
    arrRequest(base, key, { method: "POST", path: api(serviceId, "downloadclient/test"), body, timeoutMs: 45_000 }),
  testApplication: (base, key, body) =>
    arrRequest(base, key, { method: "POST", path: "/api/v1/applications/test", body, timeoutMs: 25_000 }),

  createDownloadClient: (serviceId, base, key, body) =>
    arrRequest(base, key, { method: "POST", path: api(serviceId, "downloadclient"), body, timeoutMs: 25_000 }),
  createApplication: (base, key, body) =>
    arrRequest(base, key, { method: "POST", path: "/api/v1/applications", body, timeoutMs: 25_000 }),
  listQualityProfiles: (serviceId, base, key) => arrRequest(base, key, { path: api(serviceId, "qualityprofile") }),
  listMetadataProfiles: (serviceId, base, key) => arrRequest(base, key, { path: api(serviceId, "metadataprofile") }),
  createRootFolder: (serviceId, base, key, body) =>
    arrRequest(base, key, { method: "POST", path: api(serviceId, "rootfolder"), body, timeoutMs: 25_000 })
};
