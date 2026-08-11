import { createHash } from "node:crypto";

import { readContainerFile } from "../runtime.js";

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
  sabnzbd: { path: "/config/sabnzbd.ini", format: "sabnzbd" }
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
 * is what lets Stackarr pick a category that works instead of one that fails.
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
 * Stackarr never *generates* a key. Minting one means rewriting the app's
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
        reason: `Stackarr does not read an API key for ${service.name}.`
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
  const key = parsed ? parsed.apiKey : parseArrApiKey(text);

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
