import { access } from "node:fs/promises";
import path from "node:path";

/**
 * The host paths Stackarr needs to see, and the variable that grants each one.
 *
 * The controller only perceives what its own Compose file mounted. A directory
 * that plainly exists on the host is invisible to it otherwise, and every
 * existence check inside the container then reports it missing — technically
 * true, thoroughly misleading.
 */
const REQUIRED_ROOTS = [
  { field: "stackRoot", variable: "HOST_STACK_ROOT", label: "Stack root" },
  { field: "configRoot", variable: "HOST_CONFIG_ROOT", label: "Config root" },
  { field: "mediaRoot", variable: "HOST_MEDIA_ROOT", label: "Media root" },
  { field: "downloadsRoot", variable: "HOST_DOWNLOADS_ROOT", label: "Downloads root" },
  { field: "plexLogsRoot", variable: "HOST_PLEX_LOGS_ROOT", label: "Plex logs path" }
];

/**
 * The roots this controller was actually mounted with, as Compose passed them.
 *
 * Host detection would otherwise suggest generic defaults like /opt and /srv,
 * which are not what the Compose file mounts and, on Docker Desktop, cannot be
 * mounted at all. The result was a first save that immediately reported four
 * roots as unreachable. Compose knows the answer; this is it telling us,
 * rather than the container guessing about a filesystem it cannot see.
 *
 * Empty for controllers deployed before these variables existed, which is why
 * every caller keeps its own fallback.
 */
export function mountedRootsFromEnv(env = process.env) {
  const roots = {};

  for (const root of REQUIRED_ROOTS) {
    const value = String(env[root.variable] || "").trim();

    if (value) {
      roots[root.field] = value;
    }
  }

  return roots;
}

function isCovered(mounts, hostPath) {
  return mounts.some((mount) => {
    // Mounted at the same absolute path on both sides by design, so a root is
    // covered when it is the mount itself or sits inside it.
    const source = mount.source;
    return source && (hostPath === source || hostPath.startsWith(`${source.replace(/\/+$/, "")}/`));
  });
}

/**
 * Finds configured roots the controller cannot actually see.
 *
 * This is the failure that follows from the same paths living in two places:
 * change a root in the settings UI and only `settings.json` moves, while the
 * container keeps mounting the old one. Saying which variable is missing turns
 * a baffling "does not exist" into something actionable.
 */
export const CONTROLLER_ENV_FILE = "deploy/.env";

/**
 * Finds the controller's own env file as seen from inside the container.
 *
 * Compose records where the stack was deployed from, but that path is on the
 * host and is not necessarily reachable here. On QNAP it plainly is not: the
 * label reads /share/CACHEDEV1_DATA/Container/... while what is mounted is
 * /share/Container/..., the same directory reached a different way.
 *
 * So the recorded path is tried first, then progressively shorter tails of it
 * joined onto each mounted root. A candidate only counts when the compose file
 * is actually sitting in it, which keeps this from picking a lookalike.
 */
/**
 * Where the deploy directory is mounted when the Compose file brings it along.
 *
 * A relative bind resolves against the Compose file's own directory, so this is
 * known rather than deduced. Everything below it is a fallback for controllers
 * deployed before that mount existed.
 */
export const DEPLOY_MOUNT = "/app/deploy-host";

export async function resolveControllerEnvPath({ workingDir, composeFile, mounts = [] }, options = {}) {
  const exists = options.pathExistsImpl || (async (target) => {
    try {
      await access(target);
      return true;
    } catch {
      return false;
    }
  });

  const composeName = composeFile ? composeFile.split("/").pop() : "compose.example.yml";

  // The mounted directory first: no guessing, and it works regardless of how
  // the host spells the path outside.
  //
  // Either file identifies it. Looking only for .env would fail on exactly the
  // installation that needs this most — a fresh clone, where the whole point is
  // that no .env exists yet and Stackarr is meant to write the first one.
  for (const marker of [".env", composeName, "compose.example.yml"]) {
    if (await exists(path.join(DEPLOY_MOUNT, marker))) {
      return path.join(DEPLOY_MOUNT, ".env");
    }
  }

  if (!workingDir) {
    return null;
  }

  const segments = workingDir.split("/").filter(Boolean);
  const candidates = [workingDir];

  for (const mount of mounts) {
    for (let start = 0; start < segments.length; start += 1) {
      candidates.push(path.join(mount.source, ...segments.slice(start)));
    }
  }

  for (const candidate of candidates) {
    if (await exists(path.join(candidate, composeName))) {
      return path.join(candidate, ".env");
    }
  }

  return null;
}

/**
 * Renders the controller's own env file from settings.
 *
 * The same five host paths were being stored twice — here and in settings —
 * with nothing reconciling them, so changing a root in the UI moved one and
 * left the other, and the container went on mounting the old path. Writing this
 * from settings makes settings the single source of truth; the file remains
 * because Compose has to know the mounts before the container it configures
 * exists, and a process inside that container cannot tell it.
 */
export function renderControllerEnv(settings, existing = "") {
  const managed = {
    STACKARR_PORT: readExisting(existing, "STACKARR_PORT") || "4687",
    STACKARR_LOG_LEVEL: readExisting(existing, "STACKARR_LOG_LEVEL") || "info",
    // Not derivable from settings: it is where settings themselves live.
    STACKARR_DATA_DIR: readExisting(existing, "STACKARR_DATA_DIR") || "../data",
    ...Object.fromEntries(
      REQUIRED_ROOTS.filter((root) => settings[root.field]).map((root) => [root.variable, settings[root.field]])
    )
  };

  return [
    "# Written by Stackarr from its own settings. Edit paths in the app rather",
    "# than here, or the next save will overwrite them.",
    "#",
    "# Recreate the controller for changes to take effect:",
    "#   docker compose -f compose.example.yml --env-file .env up -d",
    "",
    ...Object.entries(managed).map(([key, value]) => `${key}=${value}`),
    ""
  ].join("\n");
}

function readExisting(text, key) {
  const match = String(text || "").match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, "m"));
  return match ? match[1].trim() : null;
}

export function findUnmountedRoots(settings, controllerMounts) {
  if (!Array.isArray(controllerMounts) || controllerMounts.length === 0) {
    // Nothing to compare against — running outside a container, or the
    // controller's own definition could not be read. Silence beats a guess.
    return [];
  }

  return REQUIRED_ROOTS.filter((root) => settings[root.field])
    .filter((root) => !isCovered(controllerMounts, settings[root.field]))
    .map((root) => ({
      level: "warn",
      field: root.field,
      path: settings[root.field],
      message: `${root.label} ${settings[root.field]} is not mounted into the Stackarr container, so Stackarr cannot see it — it will report the path as missing even though it exists on the host. Set ${root.variable}=${settings[root.field]} in deploy/.env and recreate the controller.`
    }));
}
