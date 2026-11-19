import { createHash } from "node:crypto";

import { readContainerFile } from "../runtimes/index.js";

/**
 * Where each app keeps its API key. Ombi and Tautulli are absent on purpose:
 * they store theirs in a database rather than a text file, and neither is a
 * wiring target, so reading them would be effort spent acquiring a secret we
 * have no use for.
 */
const KEY_SOURCES = {
  radarr: { path: "/config/config.xml", format: "arr" },
  sonarr: { path: "/config/config.xml", format: "arr" },
  lidarr: { path: "/config/config.xml", format: "arr" },
  prowlarr: { path: "/config/config.xml", format: "arr" },
  sabnzbd: { path: "/config/sabnzbd.ini", format: "sabnzbd" },
  bazarr: { path: "/config/config/config.yaml", format: "bazarr" },
  // Seerr's config directory is /app/config, not /config — see the catalog entry.
  seerr: { path: "/app/config/settings.json", format: "seerr" }
};

export function hasReadableApiKey(serviceId) {
  return Boolean(KEY_SOURCES[serviceId]);
}

/**
 * A bounded regex rather than an XML parser. Normally reading XML this way is a
 * smell, but config.xml is machine-written against a fixed schema and we take
 * exactly one leaf element whose shape is known — a parser dependency would
 * cost more than it buys. Please do not "fix" this into a dependency.
 */
export function parseArrApiKey(text) {
  return String(text || "").match(/<ApiKey>\s*([0-9a-fA-F]{32})\s*<\/ApiKey>/)?.[1] || null;
}

/**
 * Category names SABnzbd actually has.
 *
 * The Arr apps default to a category named after their media type, and SABnzbd
 * rejects a download client naming one it does not have. Reading the real list
 * is what lets Keelarr pick a category that works instead of one that fails.
 */
function parseSabnzbdCategories(lines) {
  const start = lines.findIndex((line) => /^\s*\[categories\]\s*$/.test(line));

  if (start === -1) {
    return [];
  }

  const names = [];

  for (const line of lines.slice(start + 1)) {
    // A single-bracket heading means the categories section has ended.
    if (/^\s*\[[^[]/.test(line)) {
      break;
    }

    const match = line.match(/^\s*name\s*=\s*(.+?)\s*$/);

    if (match && match[1] !== "*") {
      names.push(match[1]);
    }
  }

  return names;
}

export function parseSabnzbdConfig(text) {
  const lines = String(text || "").split("\n");
  const read = (key) => {
    const match = lines.find((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
    return match ? match.slice(match.indexOf("=") + 1).trim() : null;
  };
  const whitelist = read("host_whitelist");

  return {
    apiKey: read("api_key"),
    completeDir: read("complete_dir"),
    downloadDir: read("download_dir"),
    categories: parseSabnzbdCategories(lines),
    hostWhitelist: whitelist ? whitelist.split(",").map((entry) => entry.trim()).filter(Boolean) : []
  };
}

/**
 * Bazarr's own key, from the `auth:` block of its config.
 *
 * Scoped to that block deliberately: the same file also holds `apikey` under
 * `sonarr:` and `radarr:` — the keys of the apps Bazarr talks to — and a plain
 * search for the field would return whichever came first.
 */
export function parseBazarrApiKey(text) {
  const lines = String(text || "").split("\n");
  const start = lines.findIndex((line) => /^auth:\s*$/.test(line));

  if (start === -1) {
    return null;
  }

  for (const line of lines.slice(start + 1)) {
    // Any unindented line ends the block.
    if (/^\S/.test(line)) {
      break;
    }

    const match = line.match(/^\s+apikey:\s*['"]?([0-9a-fA-F]{32})['"]?\s*$/);

    if (match) {
      return match[1];
    }
  }

  return null;
}


/**
 * Seerr's own key, from the `main` block of its settings document.
 *
 * Parsed as JSON rather than pattern-matched, because unlike every other key
 * here it is **not** a 32-character hex string: Seerr generates base64 of a
 * timestamp and a UUID, so it is longer, mixed-case, and can end in `=`. A
 * hex-shaped regex of the kind used for the Arr apps finds nothing in it.
 *
 * The same file holds the `apiKey` of every Radarr and Sonarr server Seerr talks
 * to, so the read is scoped to `main` for the same reason Bazarr's is scoped to
 * its `auth:` block: a search by field name would return whichever came first.
 */
export function parseSeerrApiKey(text) {
  let document;

  try {
    document = JSON.parse(String(text || ""));
  } catch {
    // Seerr writes this file on a timer and truncates it in place, so a
    // half-written document is a real state rather than corruption. Returning
    // null reports it as pending, which is the honest answer and resolves on the
    // next read.
    return null;
  }

  const key = document?.main?.apiKey;

  return typeof key === "string" && key.trim() ? key.trim() : null;
}

/**
 * A short, non-reversible label for a key.
 *
 * Enough to answer "is the key Prowlarr stored for Radarr still the key Radarr
 * is using?", which is a genuinely useful thing to show, without putting any of
 * the key itself on the wire.
 */
export function fingerprintKey(key) {
  return key ? createHash("sha256").update(key).digest("hex").slice(0, 8) : null;
}

/**
 * Reads a service's API key.
 *
 * Returns the key and its public descriptor as separate fields so a caller
 * cannot accidentally serialize the secret by spreading the result. Only
 * `descriptor` is ever safe to put on the wire.
 *
 * Keelarr never *generates* a key. Minting one means rewriting the app's
 * config and restarting it, which silently invalidates every other integration
 * pointed at that app — Ombi, Trailarr, Bazarr, and any script the user wrote.
 * A missing key almost always means the container has not finished its first
 * start, and the honest answer to that is "pending", not a new key.
 */
export async function readApiKey(settings, service, options = {}) {
  const source = KEY_SOURCES[service.id];

  if (!source) {
    return {
      key: null,
      descriptor: {
        found: false,
        state: "unsupported",
        reason: `Keelarr does not read an API key for ${service.name}.`
      }
    };
  }

  const readFileImpl = options.readContainerFileImpl || readContainerFile;
  const text = await readFileImpl(settings, service.containerName, source.path, options);

  if (text === null) {
    return {
      key: null,
      descriptor: {
        found: false,
        state: "pending",
        source: source.path,
        reason: `${service.name} has not written ${source.path} yet. A freshly installed app writes it a few seconds after it first starts.`
      }
    };
  }

  const parsed = source.format === "sabnzbd" ? parseSabnzbdConfig(text) : null;
  const PARSERS = { bazarr: parseBazarrApiKey, seerr: parseSeerrApiKey, arr: parseArrApiKey };
  const key = parsed ? parsed.apiKey : (PARSERS[source.format] || parseArrApiKey)(text);

  if (!key) {
    return {
      key: null,
      descriptor: {
        found: false,
        state: "pending",
        source: source.path,
        reason: `${service.name} has ${source.path} but has not written an API key into it yet.`
      }
    };
  }

  return {
    key,
    descriptor: {
      found: true,
      state: "found",
      source: source.path,
      fingerprint: fingerprintKey(key)
    },
    // Only SABnzbd carries extra settings worth reading while we are in there.
    // Rebuilt field by field rather than passed through, so the parsed api_key
    // cannot ride along into anything a caller decides to serialize.
    downloadSettings: parsed
      ? {
          completeDir: parsed.completeDir,
          downloadDir: parsed.downloadDir,
          categories: parsed.categories,
          hostWhitelist: parsed.hostWhitelist
        }
      : null
  };
}
