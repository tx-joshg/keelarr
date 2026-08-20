import { access, constants, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { runCommand } from "../command-runner.js";

export async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function pathWritable(filePath) {
  try {
    await access(filePath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function pathCreatable(filePath) {
  if (!filePath) {
    return false;
  }

  let current = path.resolve(filePath);

  while (true) {
    if (await pathExists(current)) {
      return pathWritable(current);
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

/**
 * Ownership and mode of a directory, or null when it cannot be read.
 */
export async function pathOwnership(filePath) {
  try {
    const stats = await stat(filePath);
    return { uid: stats.uid, gid: stats.gid, mode: stats.mode & 0o777 };
  } catch {
    return null;
  }
}

/**
 * Whether a container running as uid/gid could create files inside a directory.
 *
 * Creating a file needs write *and* execute on the directory, so both bits are
 * required rather than write alone. POSIX stops at the first matching class
 * instead of OR-ing them together — an owner match with no write bit is a
 * denial even when the group bits would have allowed it — so these are checked
 * in order.
 *
 * Supplementary groups are invisible here: the LinuxServer `abc` user is
 * routinely a member of extra groups that a stat cannot reveal, so a false
 * "no" is possible. Callers warn rather than block for that reason.
 */
export function identityCanWriteInto(ownership, uid, gid) {
  if (!ownership || !Number.isInteger(uid) || !Number.isInteger(gid)) {
    return null;
  }

  if (ownership.uid === uid) {
    return (ownership.mode & 0o300) === 0o300;
  }

  if (ownership.gid === gid) {
    return (ownership.mode & 0o030) === 0o030;
  }

  return (ownership.mode & 0o003) === 0o003;
}

function formatMode(mode) {
  return `0${(mode & 0o777).toString(8)}`;
}

/**
 * A sample of the directories inside a media root, two levels deep.
 *
 * Checking the root alone is not enough and on a NAS is usually misleading:
 * a share is commonly world-writable at the top while the per-title folders
 * inside it are created by whichever app got there first, owned by that app's
 * uid and mode 755. Those folders are where trailers, subtitles and renamed
 * files actually get written, so they are what the identity has to be checked
 * against.
 *
 * Sampling rather than walking: a library has thousands of title folders and
 * they share ownership, so a handful answers the question without a full scan.
 */
async function sampleLibraryDirectories(root, perLevel = 4) {
  const listDirs = async (dir) => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.startsWith("@"))
        .slice(0, perLevel)
        .map((entry) => path.join(dir, entry.name));
    } catch {
      return [];
    }
  };

  const top = await listDirs(root);
  const nested = await Promise.all(top.map((dir) => listDirs(dir)));

  return [...top, ...nested.flat()];
}

export async function probeDockerCandidate(binaryPath, options = {}) {
  if (!binaryPath) {
    return {
      binaryPath: null,
      dockerOk: false,
      composeOk: false,
      dockerVersion: null,
      composeVersion: null,
      error: "No binary candidate provided."
    };
  }

  try {
    const dockerResult = await runCommand(binaryPath, ["version", "--format", "{{.Client.Version}}"], {
      timeoutMs: 8_000,
      logger: options.logger
    });

    if (!dockerResult.ok) {
      return {
        binaryPath,
        dockerOk: false,
        composeOk: false,
        dockerVersion: null,
        composeVersion: null,
        error: dockerResult.stderr || dockerResult.stdout || "docker version failed"
      };
    }

    const composeResult = await runCommand(binaryPath, ["compose", "version"], {
      timeoutMs: 8_000,
      logger: options.logger
    });

    return {
      binaryPath,
      dockerOk: true,
      composeOk: composeResult.ok,
      dockerVersion: dockerResult.stdout.trim() || null,
      composeVersion: composeResult.ok ? composeResult.stdout.trim() : null,
      error: composeResult.ok ? null : composeResult.stderr || composeResult.stdout || "docker compose version failed"
    };
  } catch (error) {
    return {
      binaryPath,
      dockerOk: false,
      composeOk: false,
      dockerVersion: null,
      composeVersion: null,
      error: error.message
    };
  }
}

export async function firstSuccessfulDockerProbe(candidates, options = {}) {
  const results = [];
  const seen = new Set();

  for (const candidate of candidates.filter(Boolean)) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    const probe = await probeDockerCandidate(candidate, options);
    results.push(probe);
    if (probe.composeOk) {
      return {
        selected: probe,
        probes: results
      };
    }
  }

  return {
    selected: results.find((probe) => probe.dockerOk) || null,
    probes: results
  };
}

export function confidenceFromScore(score) {
  if (score >= 85) {
    return "high";
  }

  if (score >= 55) {
    return "medium";
  }

  return "low";
}

export function field(value, confidence, source, note = null) {
  return {
    value,
    confidence,
    source,
    note
  };
}

function result(ok, level, value, message) {
  return {
    ok,
    level,
    value,
    message
  };
}

export async function validateDockerHostProfile(settings = {}, options = {}) {
  const dockerCandidates = options.dockerCandidates || [settings.dockerBin, "docker"];
  const dockerProbe = await firstSuccessfulDockerProbe(dockerCandidates, options);
  const stackRoot = String(settings.stackRoot || "").trim();
  const configRoot = String(settings.configRoot || "").trim();
  const mediaRoot = String(settings.mediaRoot || "").trim();
  const downloadsRoot = String(settings.downloadsRoot || "").trim();
  const plexLogsRoot = String(settings.plexLogsRoot || "").trim();

  const [
    stackRootExists,
    stackRootWritable,
    stackRootCreatable,
    configRootExists,
    mediaRootExists,
    downloadsRootExists,
    plexLogsExists
  ] = await Promise.all([
    stackRoot ? pathExists(stackRoot) : Promise.resolve(false),
    stackRoot ? pathWritable(stackRoot) : Promise.resolve(false),
    stackRoot ? pathCreatable(stackRoot) : Promise.resolve(false),
    configRoot ? pathExists(configRoot) : Promise.resolve(false),
    mediaRoot ? pathExists(mediaRoot) : Promise.resolve(false),
    downloadsRoot ? pathExists(downloadsRoot) : Promise.resolve(false),
    plexLogsRoot ? pathExists(plexLogsRoot) : Promise.resolve(false)
  ]);

  // Existence is not the question that matters for these roots. The containers
  // run as PUID:PGID rather than as Keelarr, so a directory that exists and is
  // readable here can still be unwritable to the identity the apps actually
  // use — which surfaces as a permission denied on the first write, long after
  // setup reported success.
  const puid = Number.parseInt(String(settings.puid ?? "").trim(), 10);
  const pgid = Number.parseInt(String(settings.pgid ?? "").trim(), 10);
  const explicitRoots = [
    ["Media root", mediaRoot, mediaRootExists],
    ["Config root", configRoot, configRootExists],
    ["Downloads root", downloadsRoot, downloadsRootExists]
  ];
  // The downloads root usually sits inside the media root, so drop anything the
  // explicit roots already cover rather than reporting the same directory twice
  // under two names.
  const named = new Set(explicitRoots.map(([, value]) => value).filter(Boolean));
  const libraryDirs = (mediaRoot && mediaRootExists ? await sampleLibraryDirectories(mediaRoot) : []).filter(
    (dir) => !named.has(dir)
  );
  const identityTargets = [...explicitRoots, ...libraryDirs.map((dir) => ["Library folder", dir, true])];
  const identityChecks = await Promise.all(
    identityTargets
      .filter(([, value, exists]) => value && exists)
      .map(async ([label, value]) => {
        const ownership = await pathOwnership(value);
        return { label, path: value, ownership, writable: identityCanWriteInto(ownership, puid, pgid) };
      })
  );
  const identityBlocked = identityChecks.filter((check) => check.writable === false);

  const errors = [];
  const warnings = [];

  if (!dockerProbe.selected?.dockerOk) {
    errors.push(`Docker binary could not be executed: ${settings.dockerBin || "docker"}.`);
  }
  if (!dockerProbe.selected?.composeOk) {
    errors.push(`Docker Compose could not be executed from ${dockerProbe.selected?.binaryPath || settings.dockerBin || "docker"}.`);
  }
  if (!stackRoot) {
    errors.push("Stack root is required.");
  } else if (!(stackRootWritable || stackRootCreatable)) {
    errors.push(`Stack root is not writable or creatable: ${stackRoot}.`);
  }
  if (!configRoot) {
    errors.push("Config root is required.");
  }
  if (!mediaRoot) {
    errors.push("Media root is required.");
  }
  if (!downloadsRoot) {
    errors.push("Downloads root is required.");
  }

  if (configRoot && !configRootExists) {
    warnings.push(`Config root does not exist yet: ${configRoot}.`);
  }
  if (mediaRoot && !mediaRootExists) {
    warnings.push(`Media root does not exist yet: ${mediaRoot}.`);
  }
  if (downloadsRoot && !downloadsRootExists) {
    warnings.push(`Downloads root does not exist yet: ${downloadsRoot}.`);
  }
  if (downloadsRoot && mediaRoot && !downloadsRoot.startsWith(mediaRoot)) {
    warnings.push("Downloads root is outside the media root. Hardlinks and atomic moves may fail.");
  }
  if (settings.selectedServiceIds?.includes("tautulli") && !plexLogsRoot) {
    warnings.push("Tautulli is selected but Plex logs path is blank.");
  } else if (plexLogsRoot && !plexLogsExists) {
    warnings.push(`Plex logs path does not exist yet: ${plexLogsRoot}.`);
  }

  if (!Number.isInteger(puid) || !Number.isInteger(pgid)) {
    warnings.push(`PUID and PGID must be numeric to be checked against the configured roots. Got ${settings.puid}:${settings.pgid}.`);
  }

  // One line per blocked root, but library folders share a cause and a fix, so
  // they are summarised rather than listed one per title.
  for (const check of identityBlocked.filter((item) => item.label !== "Library folder")) {
    warnings.push(
      `${check.label} ${check.path} is owned by ${check.ownership.uid}:${check.ownership.gid} with mode ${formatMode(check.ownership.mode)}, which PUID ${puid} / PGID ${pgid} cannot write to. Containers will fail with "permission denied" on their first write there.`
    );
  }

  const blockedLibrary = identityBlocked.filter((item) => item.label === "Library folder");

  if (blockedLibrary.length) {
    const sample = blockedLibrary[0];
    warnings.push(
      `PUID ${puid} / PGID ${pgid} cannot write into ${blockedLibrary.length} of ${identityChecks.filter((item) => item.label === "Library folder").length} sampled library folders, including ${sample.path} (owned by ${sample.ownership.uid}:${sample.ownership.gid}, mode ${formatMode(sample.ownership.mode)}). The media root itself is writable, so this will pass a surface check and then fail on every write into an existing library folder.`
    );
  }

  return {
    ok: errors.length === 0,
    adapterId: options.adapterId || settings.adapterType || "generic-docker",
    label: options.label || "Docker Host",
    errors,
    warnings,
    selectedBinary: dockerProbe.selected?.binaryPath || settings.dockerBin || "docker",
    diagnostics: dockerProbe.probes,
    fieldResults: {
      dockerBin: result(Boolean(dockerProbe.selected?.composeOk), dockerProbe.selected?.composeOk ? "info" : "error", settings.dockerBin || "docker", dockerProbe.selected?.composeOk ? "Docker and Compose validated." : dockerProbe.probes.at(-1)?.error || "Docker validation failed."),
      stackRoot: result(Boolean(stackRootWritable || stackRootCreatable), stackRootWritable || stackRootCreatable ? "info" : "error", stackRoot, stackRootExists ? "Stack root is writable." : stackRootCreatable ? "Stack root can be created." : "Stack root is not writable."),
      configRoot: result(Boolean(configRoot), configRoot && configRootExists ? "info" : configRoot ? "warn" : "error", configRoot, configRootExists ? "Config root exists." : configRoot ? "Config root will need to exist before containers use it." : "Config root is required."),
      mediaRoot: result(Boolean(mediaRoot), mediaRoot && mediaRootExists ? "info" : mediaRoot ? "warn" : "error", mediaRoot, mediaRootExists ? "Media root exists." : mediaRoot ? "Media root was not found on disk." : "Media root is required."),
      downloadsRoot: result(Boolean(downloadsRoot), downloadsRoot && downloadsRootExists ? "info" : downloadsRoot ? "warn" : "error", downloadsRoot, downloadsRootExists ? "Downloads root exists." : downloadsRoot ? "Downloads root was not found on disk." : "Downloads root is required."),
      identity: result(identityBlocked.length === 0, identityBlocked.length ? "warn" : "info", `${settings.puid ?? ""}:${settings.pgid ?? ""}`, identityBlocked.length ? `PUID ${puid} / PGID ${pgid} cannot write to ${identityBlocked.map((check) => check.path).join(", ")}.` : identityChecks.length ? "PUID and PGID can write to every configured root that exists." : "No existing roots were available to check PUID and PGID against."),
      plexLogsRoot: result(!settings.selectedServiceIds?.includes("tautulli") || Boolean(plexLogsRoot), plexLogsRoot ? (plexLogsExists ? "info" : "warn") : settings.selectedServiceIds?.includes("tautulli") ? "warn" : "info", plexLogsRoot, plexLogsRoot ? (plexLogsExists ? "Plex logs path exists." : "Plex logs path was not found on disk.") : settings.selectedServiceIds?.includes("tautulli") ? "Plex logs path is recommended for Tautulli." : "Plex logs path is optional.")
    }
  };
}
