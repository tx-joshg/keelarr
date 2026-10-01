import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_IDLE_TIMEOUT_MS, runCommand } from "./command-runner.js";

function composeArgs(service, ...tail) {
  return [
    "compose",
    "-f",
    service.composePath,
    "--env-file",
    service.envPath,
    ...tail
  ];
}

async function backupFileIfPresent(filePath, destinationDir) {
  try {
    const outputPath = path.join(destinationDir, path.basename(filePath));
    await copyFile(filePath, outputPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

export function normalizeComposePsData(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (value && typeof value === "object") {
    return [value];
  }

  return [];
}

export function normalizeImageId(value) {
  const trimmed = String(value || "").trim();
  return trimmed || null;
}

export function deriveUpdateStatusFromPullResult(output, runningImageId = null, availableImageId = null) {
  if (/Downloaded newer image/i.test(output)) {
    return "ready";
  }

  if (/Image is up to date|up to date/i.test(output)) {
    return "current";
  }

  if (runningImageId && availableImageId) {
    return runningImageId === availableImageId ? "current" : "ready";
  }

  return "unknown";
}

async function readContainerImageId(settings, service, options = {}) {
  const result = await runCommand(settings.dockerBin, ["inspect", service.containerName, "--format", "{{.Image}}"], {
    logger: options.logger
  });

  if (!result.ok) {
    return null;
  }

  return normalizeImageId(result.stdout);
}

async function readImageRepoDigest(settings, imageRef, options = {}) {
  if (!imageRef) {
    return null;
  }

  const result = await runCommand(
    settings.dockerBin,
    ["image", "inspect", imageRef, "--format", "{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}"],
    {
      logger: options.logger
    }
  );

  if (!result.ok) {
    return null;
  }

  return normalizeImageId(result.stdout);
}

async function readTaggedImageId(settings, service, options = {}) {
  const result = await runCommand(settings.dockerBin, ["image", "inspect", service.image, "--format", "{{.Id}}"], {
    logger: options.logger
  });

  if (!result.ok) {
    return null;
  }

  return normalizeImageId(result.stdout);
}

// Regenerated on demand by the apps themselves, and large enough to dominate a
// snapshot. `tar --exclude` matches case-sensitively and apps disagree on
// casing — Trailarr uses `backups` while the Arr apps use `Backups` — so each
// name is matched with a character class rather than one fixed spelling.
// `web` is an app's shipped frontend bundle: on Trailarr it is 520M of assets
// that reinstall themselves, and it dwarfed the 13M database it was wrapping.
export const CONFIG_SNAPSHOT_EXCLUDES = [
  "./[Ll]ogs",
  "./[Mm]edia[Cc]over",
  "./[Bb]ackups",
  "./[Cc]ache",
  "./web"
];
const SNAPSHOT_HELPER_IMAGE = "alpine:latest";
export const CONFIG_SNAPSHOT_FILE = "config-snapshot.tar.gz";

/**
 * Finds whatever is mounted at /config, which may be a bind path or a named
 * volume depending on how the container was originally created.
 */
export async function readConfigMountSource(settings, service, options = {}) {
  const result = await runCommand(
    settings.dockerBin,
    [
      "inspect",
      service.containerName,
      "--format",
      '{{range .Mounts}}{{if eq .Destination "/config"}}{{.Type}}|{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}'
    ],
    { logger: options.logger }
  );

  if (!result.ok) {
    return null;
  }

  const [type, source] = String(result.stdout || "").trim().split("|");

  if (!type || !source) {
    return null;
  }

  return { type, source };
}

/**
 * Full `docker inspect` output for several containers in one call.
 *
 * Containers that do not exist are skipped by the daemon rather than failing
 * the batch, so the caller matches results back by name instead of by position.
 */
export async function inspectContainers(settings, containerNames, options = {}) {
  const names = (containerNames || []).filter(Boolean);

  if (names.length === 0) {
    return [];
  }

  const result = await runCommand(settings.dockerBin, ["inspect", ...names], {
    logger: options.logger,
    timeoutMs: options.timeoutMs
  });

  try {
    const parsed = JSON.parse(String(result.stdout || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Reads one small text file out of a running container.
 *
 * Deliberately `exec` rather than the helper-container pattern used for
 * snapshots. That pattern exists to reach *stopped* containers and named
 * volumes; reading an app's settings only makes sense while the app is running,
 * and `exec cat` avoids starting a container per file. Returns null rather than
 * throwing when the file is absent, because "not written yet" is a normal state
 * for an app that has only just started.
 */
export async function readContainerFile(settings, containerName, filePath, options = {}) {
  const result = await runCommand(
    settings.dockerBin,
    ["exec", containerName, "cat", filePath],
    {
      logger: options.logger,
      timeoutMs: options.timeoutMs,
      // This is how every app's secrets are read. Its output must never reach
      // the log, at any level.
      sensitive: true
    }
  );

  return result.ok ? String(result.stdout || "") : null;
}

/**
 * Captures the service's configuration and database so a rollback can restore
 * the state the app had *before* an upgrade migrated it forward. Rolling the
 * image back alone is not enough once a schema migration has run.
 *
 * Runs through a helper container because a named volume is not reachable from
 * the controller's own filesystem.
 */
export async function snapshotConfig(settings, service, backupDir, options = {}) {
  const mount = options.mount ?? (await readConfigMountSource(settings, service, options));

  if (!mount) {
    return { ok: false, skipped: true, reason: "No /config mount found." };
  }

  const excludes = CONFIG_SNAPSHOT_EXCLUDES.flatMap((entry) => [`--exclude=${entry}`]);
  const result = await runCommand(
    settings.dockerBin,
    [
      "run", "--rm",
      "-v", `${mount.source}:/src:ro`,
      "-v", `${backupDir}:/backup`,
      options.helperImage || SNAPSHOT_HELPER_IMAGE,
      "tar", "czf", `/backup/${CONFIG_SNAPSHOT_FILE}`, "-C", "/src", ...excludes, "."
    ],
    { logger: options.logger, timeoutMs: options.timeoutMs || 300_000 }
  );

  if (!result.ok) {
    return { ok: false, skipped: false, reason: result.stderr || "Snapshot failed." };
  }

  // Report the size so an unexpectedly huge capture is visible rather than
  // quietly eating disk on every upgrade.
  const sized = await runCommand(
    settings.dockerBin,
    [
      "run", "--rm", "-v", `${backupDir}:/backup:ro`,
      options.helperImage || SNAPSHOT_HELPER_IMAGE,
      "sh", "-c", `du -h /backup/${CONFIG_SNAPSHOT_FILE} 2>/dev/null | cut -f1`
    ],
    { logger: options.logger, timeoutMs: 60_000 }
  );

  return {
    ok: true,
    skipped: false,
    mountType: mount.type,
    mountSource: mount.source,
    size: sized.ok ? (sized.stdout.trim() || null) : null,
    excluded: CONFIG_SNAPSHOT_EXCLUDES
  };
}

/**
 * The shell the restore helper container runs: clear what the snapshot covers,
 * then extract it over the top.
 *
 * Only what the snapshot could have captured is cleared. The excludes are not
 * incidental — `[Bb]ackups` is the app's own database backups, the thing an
 * operator reaches for when a rollback did not work either — so wiping all of
 * /config to restore an archive that never contained them would delete the
 * recovery copies to perform the recovery.
 */
export function buildConfigRestoreScript(excludes = CONFIG_SNAPSHOT_EXCLUDES, snapshotFile = CONFIG_SNAPSHOT_FILE) {
  const keep = (excludes?.length ? excludes : CONFIG_SNAPSHOT_EXCLUDES)
    .map((entry) => entry.replace(/^\.\//, ""))
    .join("|");

  // The archive is read through once before anything is deleted. A snapshot
  // that is missing or truncated would otherwise be discovered by `tar xzf`
  // after the live config was already gone, turning a failed upgrade into a
  // fresh install. `set -e` stops here instead.
  //
  // Both dot globs are needed: `.[!.]*` misses a name beginning with two dots,
  // and `.??*` catches those while still skipping `.` and `..` themselves.
  // `[ -e ]` guards the no-match case, where a glob comes through literally,
  // and makes the overlap between the two harmless. `-L` catches it too: `-e`
  // is false for a dangling symlink, so one left behind by the upgraded app
  // would survive a restore meant to discard it. `--` keeps a config entry
  // named like an option — `-v` is a legal filename — from being read as one,
  // which `rm` would otherwise accept and silently not delete.
  return `set -e
tar tzf /backup/${snapshotFile} > /dev/null
cd /dst
for entry in * .[!.]* .??*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  case "$entry" in
    ${keep}) continue ;;
  esac
  rm -rf -- "$entry"
done
tar xzf /backup/${snapshotFile} -C /dst`;
}

/**
 * Replaces the live /config with a snapshot. Destructive by design: anything
 * the app wrote after the snapshot is discarded, which is the point when an
 * upgrade has migrated a database beyond what the old version can read.
 *
 * What the snapshot deliberately left out is left alone. The excludes are not
 * incidental — `[Bb]ackups` is the app's own database backups, which is exactly
 * what an operator needs if the rollback does not work either, and clearing all
 * of /config would delete them to restore an archive that never contained them.
 * So everything the snapshot could have captured goes, and everything it
 * excluded by design stays.
 */
export async function restoreConfigSnapshot(settings, service, backupDir, options = {}) {
  const mount = options.mount ?? (await readConfigMountSource(settings, service, options));

  if (!mount) {
    return { ok: false, reason: "No /config mount found." };
  }

  const result = await runCommand(
    settings.dockerBin,
    [
      "run", "--rm",
      "-v", `${mount.source}:/dst`,
      "-v", `${backupDir}:/backup:ro`,
      options.helperImage || SNAPSHOT_HELPER_IMAGE,
      // The exclusions recorded with this snapshot, not today's list: an
      // archive made by an older version may have kept different directories,
      // and clearing by the current list would either delete something the
      // archive deliberately omitted or preserve something it captured.
      "sh", "-c", buildConfigRestoreScript(options.excludes)
    ],
    { logger: options.logger, timeoutMs: options.timeoutMs || 300_000 }
  );

  return {
    ok: result.ok,
    reason: result.ok ? null : result.stderr || "Restore failed.",
    mountSource: mount.source
  };
}

export function buildRollbackRecord(service, { imageId, imageRepoDigest, backedUpAt, configSnapshot = null }) {
  return {
    serviceId: service.id,
    containerName: service.containerName,
    // The tag the stack asks for, which is usually mutable (`:latest`).
    image: service.image || null,
    // The image the container was actually running before this operation.
    // Rollback needs this: re-pulling the tag after an upgrade would just
    // fetch the new image again.
    imageId: imageId || null,
    imageRepoDigest: imageRepoDigest || null,
    // Present when the app's /config was captured alongside the image, which
    // is what makes a rollback survive a forward database migration.
    configSnapshot,
    backedUpAt
  };
}

/**
 * Enforces the retention setting after a new backup lands. Backups are
 * timestamped directories, so lexical order is chronological and the newest
 * entries are simply the tail.
 */
export async function pruneServiceBackups(settings, serviceId, options = {}) {
  const keep = Number(settings.backupRetention ?? 1);

  // 0 (or anything non-positive) means keep everything.
  if (!Number.isFinite(keep) || keep <= 0) {
    return { pruned: 0, kept: null };
  }

  const root = path.join(settings.stackRoot, ".keelarr-backups", serviceId);
  let stamps = [];

  try {
    stamps = (await readdir(root)).sort();
  } catch {
    return { pruned: 0, kept: 0 };
  }

  const doomed = stamps.slice(0, Math.max(0, stamps.length - keep));

  for (const stamp of doomed) {
    await (options.rmImpl || rm)(path.join(root, stamp), { recursive: true, force: true });
  }

  if (doomed.length) {
    options.logger?.info("backup.pruned", { serviceId, pruned: doomed.length, kept: keep });
  }

  return { pruned: doomed.length, kept: Math.min(stamps.length, keep) };
}

export async function backupService(settings, service, options = {}) {
  const backedUpAt = new Date().toISOString();
  const timestamp = backedUpAt.replace(/[:.]/g, "-");
  const backupDir = path.join(settings.stackRoot, ".keelarr-backups", service.id, timestamp);
  await mkdir(backupDir, { recursive: true });

  await backupFileIfPresent(service.composePath, backupDir);
  await backupFileIfPresent(service.envPath, backupDir);

  const inspectResult = await runCommand(settings.dockerBin, ["inspect", service.containerName], {
    logger: options.logger
  });
  if (inspectResult.ok) {
    await writeFile(path.join(backupDir, "inspect.json"), inspectResult.stdout, "utf8");
  }

  // Capture the running image identity before anything pulls or recreates it.
  const imageId = await readContainerImageId(settings, service, options);
  const snapshot = options.snapshotConfig === false
    ? { ok: false, skipped: true, reason: "Config snapshot disabled." }
    : await (options.snapshotConfigImpl || snapshotConfig)(settings, service, backupDir, options);
  const rollback = buildRollbackRecord(service, {
    imageId,
    imageRepoDigest: await readImageRepoDigest(settings, imageId, options),
    backedUpAt,
    configSnapshot: snapshot.ok
      ? {
          file: CONFIG_SNAPSHOT_FILE,
          mountType: snapshot.mountType,
          mountSource: snapshot.mountSource,
          size: snapshot.size || null,
          excluded: snapshot.excluded
        }
      : null
  });
  await writeFile(path.join(backupDir, "rollback.json"), `${JSON.stringify(rollback, null, 2)}\n`, "utf8");

  options.logger?.info("service.backup", {
    serviceId: service.id,
    containerName: service.containerName,
    backupDir,
    imageId: rollback.imageId,
    imageRepoDigest: rollback.imageRepoDigest,
    configSnapshot: rollback.configSnapshot ? "captured" : (snapshot.reason || "unavailable")
  });

  // Prune after writing, so the new backup is always among those kept.
  const pruned = await pruneServiceBackups(settings, service.id, options);

  return {
    backupDir,
    rollback,
    configSnapshot: snapshot,
    pruned: pruned.pruned
  };
}

export async function stopContainer(settings, containerName, options = {}) {
  return runCommand(settings.dockerBin, ["stop", containerName], {
    logger: options.logger
  });
}

export async function startContainer(settings, containerName, options = {}) {
  return runCommand(settings.dockerBin, ["start", containerName], {
    logger: options.logger
  });
}

/**
 * Renaming rather than removing is what makes a cutover reversible: the
 * original container object survives, so revert is a rename back instead of a
 * reconstruction from the inspect backup.
 */
export async function renameContainer(settings, fromName, toName, options = {}) {
  return runCommand(settings.dockerBin, ["rename", fromName, toName], {
    logger: options.logger
  });
}

export async function removeContainer(settings, containerName, options = {}) {
  return runCommand(settings.dockerBin, ["rm", "-f", containerName], {
    logger: options.logger
  });
}

export async function containerExists(settings, containerName, options = {}) {
  const result = await runCommand(settings.dockerBin, ["inspect", containerName, "--format", "{{.Id}}"], {
    logger: options.logger
  });

  return result.ok;
}

export async function inspectContainerState(settings, containerName, options = {}) {
  const result = await runCommand(
    settings.dockerBin,
    ["inspect", containerName, "--format", "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}"],
    {
      logger: options.logger
    }
  );

  if (!result.ok) {
    return {
      exists: false,
      status: null,
      healthStatus: null
    };
  }

  const [status, healthStatus] = String(result.stdout || "").trim().split("|");

  return {
    exists: true,
    status: status || null,
    // Empty when the image declares no HEALTHCHECK, which is common across
    // this catalog. Callers must not read that as unhealthy.
    healthStatus: healthStatus || null
  };
}

/** `down` without `-v` so named volumes backing /config are never removed. */
export async function composeDown(settings, service, options = {}) {
  return runCommand(settings.dockerBin, composeArgs(service, "down"), {
    logger: options.logger
  });
}

/**
 * Finds the newest backup that recorded a usable previous image.
 *
 * Backups are timestamped directories, so lexical sort is chronological.
 * Entries whose recorded image matches what is running are skipped — rolling
 * back to the image you are already on is a no-op the caller should not offer.
 */
export async function findRollbackPoint(settings, service, options = {}) {
  const serviceBackupRoot = path.join(settings.stackRoot, ".keelarr-backups", service.id);
  let stamps = [];

  try {
    stamps = (await readdir(serviceBackupRoot)).sort().reverse();
  } catch {
    return null;
  }

  const runningImageId = options.runningImageId
    ?? (await readContainerImageId(settings, service, options));

  for (const stamp of stamps) {
    let record;

    try {
      record = JSON.parse(await readFile(path.join(serviceBackupRoot, stamp, "rollback.json"), "utf8"));
    } catch {
      continue;
    }

    const imageRef = record.imageRepoDigest || record.imageId;

    if (!imageRef || record.imageId === runningImageId) {
      continue;
    }

    return {
      backupDir: path.join(serviceBackupRoot, stamp),
      backedUpAt: record.backedUpAt || null,
      imageRef,
      imageId: record.imageId || null,
      imageRepoDigest: record.imageRepoDigest || null,
      taggedImage: record.image || null,
      configSnapshot: record.configSnapshot || null
    };
  }

  return null;
}

export async function imageExistsLocally(settings, imageRef, options = {}) {
  const result = await runCommand(settings.dockerBin, ["image", "inspect", imageRef, "--format", "{{.Id}}"], {
    logger: options.logger
  });

  return result.ok;
}

/** `down -v` would also destroy named volumes, so volume removal is explicit. */
export async function composeDownRemovingVolumes(settings, service, options = {}) {
  return runCommand(settings.dockerBin, composeArgs(service, "down", "-v"), {
    logger: options.logger
  });
}

export async function removeImage(settings, imageRef, options = {}) {
  const result = await runCommand(settings.dockerBin, ["image", "rm", imageRef], {
    logger: options.logger
  });
  const output = `${result.stdout}${result.stderr}`;

  // Another service on the same image keeps it alive; that is not a failure.
  if (!result.ok && /image is being used|conflict/i.test(output)) {
    return { ok: true, removed: false, reason: "Image kept: another container still uses it." };
  }

  // Nothing to delete is a success, not an error. This happens whenever a
  // failed install never managed to pull the image in the first place.
  if (!result.ok && /no such image|reference does not exist/i.test(output)) {
    return { ok: true, removed: false, reason: "Image was not present on this host." };
  }

  return {
    ok: result.ok,
    removed: result.ok,
    reason: result.ok ? null : (result.stderr || "Could not remove image.").split("\n").filter(Boolean).pop()
  };
}

/**
 * Measures what a removal would delete, so the confirmation can show real
 * paths and sizes instead of asking the operator to trust a checkbox.
 */
export async function measurePath(settings, targetPath, options = {}) {
  if (!targetPath) {
    return null;
  }

  const result = await runCommand(
    settings.dockerBin,
    [
      "run", "--rm", "-v", `${targetPath}:/target:ro`,
      options.helperImage || "alpine:latest",
      "sh", "-c", "du -sh /target 2>/dev/null | cut -f1"
    ],
    { logger: options.logger, timeoutMs: 60_000 }
  );

  return result.ok ? (result.stdout.trim() || null) : null;
}

export async function restartService(settings, service, options = {}) {
  return runCommand(settings.dockerBin, composeArgs(service, "restart"), {
    logger: options.logger
  });
}

export async function composePs(settings, service, options = {}) {
  const result = await runCommand(settings.dockerBin, composeArgs(service, "ps", "--format", "json"), {
    logger: options.logger
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.stderr || result.stdout || "Unable to query compose status."
    };
  }

  try {
    const parsed = JSON.parse(result.stdout || "[]");
    return { ok: true, data: normalizeComposePsData(parsed) };
  } catch {
    return {
      ok: false,
      error: "Compose returned invalid JSON."
    };
  }
}

/**
 * Creates the shared network if it is missing. Declared external in generated
 * stacks, so it has to exist before the first `compose up` or the deploy fails.
 */
export async function ensureSharedNetwork(settings, networkName, options = {}) {
  const exists = await runCommand(settings.dockerBin, ["network", "inspect", networkName, "--format", "{{.Id}}"], {
    logger: options.logger
  });

  if (exists.ok) {
    return { ok: true, created: false };
  }

  const created = await runCommand(settings.dockerBin, ["network", "create", networkName], {
    logger: options.logger
  });

  // A concurrent deploy may have won the race; that is still success.
  if (!created.ok && /already exists/i.test(`${created.stdout}${created.stderr}`)) {
    return { ok: true, created: false };
  }

  return { ok: created.ok, created: created.ok, error: created.ok ? null : created.stderr };
}

// Docker's own wording for this is opaque. Translate the common failures into
// something that says what to actually do about it.
export function explainDeployFailure(output = "") {
  const text = String(output || "");

  if (/no matching manifest for/i.test(text)) {
    const platform = text.match(/no matching manifest for (\S+)/i)?.[1] || "this host";
    return `The image has no build for ${platform}. This usually means the project no longer publishes images for this architecture.`;
  }

  if (/manifest unknown|not found: manifest/i.test(text)) {
    return "The image tag does not exist in the registry.";
  }

  if (/port is already allocated|address already in use/i.test(text)) {
    // Naming the port is the whole value of the message: "a port is in use" on
    // a host running a dozen containers sends you looking through all of them.
    const port = text.match(/Bind for [^:]*:(\d+) failed/i)?.[1]
      || text.match(/(?:0\.0\.0\.0|127\.0\.0\.1):(\d+)/)?.[1];

    return port
      ? `Host port ${port} is already in use by another container or service. Change this app's port in Settings, or stop whatever holds ${port}.`
      : "That host port is already in use by another container or service.";
  }

  if (/pull access denied|authentication required/i.test(text)) {
    return "The registry refused the pull. The image may be private or the tag may have been removed.";
  }

  return null;
}

export async function generateAndDeploy(settings, service, options = {}) {
  // `up -d` pulls when the image is not local yet, so a first install is a
  // download too and gets judged on progress rather than a fixed deadline.
  return runCommand(settings.dockerBin, composeArgs(service, "up", "-d"), {
    logger: options.logger,
    idleTimeoutMs: options.pullIdleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS
  });
}

export async function installService(settings, service, options = {}) {
  await backupService(settings, service, options);
  return generateAndDeploy(settings, service, options);
}

export async function upgradeService(settings, service, options = {}) {
  await backupService(settings, service, options);

  const pullResult = await runCommand(settings.dockerBin, composeArgs(service, "pull"), {
    logger: options.logger,
    idleTimeoutMs: options.pullIdleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS
  });
  if (!pullResult.ok) {
    // Nothing has changed yet: the old container is still running. A caller
    // can report this without reverting anything.
    return { ...pullResult, phase: "pull" };
  }

  const upResult = await runCommand(settings.dockerBin, composeArgs(service, "up", "-d"), {
    logger: options.logger,
    idleTimeoutMs: options.pullIdleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS
  });
  // A failed `up` is a different situation from a failed pull: the old
  // container is already gone and the new one never started. That is "did not
  // come up", and a caller with auto-revert on treats it as such.
  return {
    ok: upResult.ok,
    code: upResult.code,
    phase: "up",
    stdout: `${pullResult.stdout}\n${upResult.stdout}`.trim(),
    stderr: `${pullResult.stderr}\n${upResult.stderr}`.trim()
  };
}

/** Pulls an image by reference, outside any compose project. */
export async function pullImage(settings, imageRef, options = {}) {
  return runCommand(settings.dockerBin, ["pull", imageRef], {
    logger: options.logger,
    idleTimeoutMs: options.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS
  });
}

/** The id a tag currently resolves to on this host, or null when absent. */
export async function readImageId(settings, imageRef, options = {}) {
  try {
    const result = await runCommand(settings.dockerBin, ["image", "inspect", imageRef, "--format", "{{.Id}}"], {
      logger: options.logger
    });
    return normalizeImageId(result.stdout);
  } catch {
    return null;
  }
}

/** The image a running container is actually on, by container name. */
export async function readContainerImageIdByName(settings, containerName, options = {}) {
  try {
    const result = await runCommand(settings.dockerBin, ["inspect", containerName, "--format", "{{.Image}}"], {
      logger: options.logger
    });
    return normalizeImageId(result.stdout);
  } catch {
    return null;
  }
}

/** Points a local tag at an image that already exists on this host. */
export async function tagImage(settings, sourceRef, targetRef, options = {}) {
  return runCommand(settings.dockerBin, ["tag", sourceRef, targetRef], { logger: options.logger });
}

/** The tail of a container's logs, for reporting what a helper did. */
export async function readContainerLogs(settings, containerName, { tail = 40, logger = null } = {}) {
  try {
    const result = await runCommand(settings.dockerBin, ["logs", "--tail", String(tail), containerName], { logger });
    return `${result.stdout}\n${result.stderr}`.trim();
  } catch {
    return "";
  }
}

/** Status and exit code of a container, for deciding what a helper concluded. */
export async function readContainerOutcome(settings, containerName, options = {}) {
  try {
    const result = await runCommand(
      settings.dockerBin,
      ["inspect", containerName, "--format", "{{.State.Status}}|{{.State.ExitCode}}"],
      { logger: options.logger }
    );
    const [status, exitCode] = String(result.stdout || "").trim().split("|");
    return { exists: true, status: status || null, exitCode: Number.parseInt(exitCode, 10) };
  } catch {
    return { exists: false, status: null, exitCode: null };
  }
}

/**
 * Starts a container and returns without waiting for it.
 *
 * Every other helper here runs `--rm` in the foreground, which is right when
 * the caller outlives the work. The controller replacing its own container is
 * the one case where it does not: the process issuing the recreate is the one
 * being recreated, so the work has to be given to something that survives it.
 */
export async function runDetachedContainer(settings, spec, options = {}) {
  const args = ["run", "-d", "--name", spec.name];

  if (spec.network) {
    args.push("--network", spec.network);
  }

  for (const [key, value] of Object.entries(spec.labels || {})) {
    args.push("--label", `${key}=${value}`);
  }

  for (const mount of spec.mounts || []) {
    args.push("-v", `${mount.source}:${mount.target}${mount.readOnly ? ":ro" : ""}`);
  }

  if (spec.workingDir) {
    args.push("-w", spec.workingDir);
  }

  // Values go in as environment rather than interpolated into the script, so a
  // path containing a quote cannot rewrite what the helper runs.
  for (const [key, value] of Object.entries(spec.environment || {})) {
    args.push("-e", `${key}=${value}`);
  }

  if (spec.entrypoint) {
    args.push("--entrypoint", spec.entrypoint);
  }

  args.push(spec.image);

  for (const argument of spec.command || []) {
    args.push(argument);
  }

  return runCommand(settings.dockerBin, args, { logger: options.logger });
}

export async function checkForUpdates(settings, service, options = {}) {
  // Checking is itself a pull, so it inherits the same reasoning: a slow
  // download is not a failed one.
  const result = await runCommand(settings.dockerBin, composeArgs(service, "pull"), {
    logger: options.logger,
    idleTimeoutMs: options.pullIdleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS
  });
  const combinedOutput = `${result.stdout}\n${result.stderr}`.trim();
  let runningImageId = null;
  let availableImageId = null;

  if (result.ok) {
    [runningImageId, availableImageId] = await Promise.all([
      readContainerImageId(settings, service, options),
      readTaggedImageId(settings, service, options)
    ]);
  }

  const status = deriveUpdateStatusFromPullResult(combinedOutput, runningImageId, availableImageId);

  return {
    ...result,
    updateStatus: status
  };
}

export async function upgradeAllServices(settings, services, options = {}) {
  const results = [];

  for (const service of services) {
    results.push({
      serviceId: service.id,
      ...(await upgradeService(settings, service, options))
    });
  }

  return results;
}
