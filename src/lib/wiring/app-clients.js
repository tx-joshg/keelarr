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
 * The read-only surface the wiring check needs.
 *
 * `testall` is included despite being a POST: it runs each app's own connection
 * tests against what is already configured and changes nothing. That is what
 * lets a read-only check report whether existing wiring actually works, rather
 * than only whether it looks plausible.
 *
 * SABnzbd is deliberately absent. Its API takes the key as a query parameter,
 * which would write the secret into its access log, and we do not need it —
 * each Arr's own download-client test already proves reachability and the key.
 */
export const arrApi = {
  systemStatus: (serviceId, base, key) => arrRequest(base, key, { path: api(serviceId, "system/status") }),
  listDownloadClients: (serviceId, base, key) => arrRequest(base, key, { path: api(serviceId, "downloadclient") }),
  listRootFolders: (serviceId, base, key) => arrRequest(base, key, { path: api(serviceId, "rootfolder") }),
  listRemotePathMappings: (serviceId, base, key) =>
    arrRequest(base, key, { path: api(serviceId, "remotepathmapping") }),
  listApplications: (base, key) => arrRequest(base, key, { path: "/api/v1/applications" }),
  testAllDownloadClients: (serviceId, base, key) =>
    arrRequest(base, key, { method: "POST", path: api(serviceId, "downloadclient/testall") }),
  testAllApplications: (base, key) => arrRequest(base, key, { method: "POST", path: "/api/v1/applications/testall" })
};
