import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./command-runner.js";

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
 * Replaces the live /config with a snapshot. Destructive by design: anything
 * the app wrote after the snapshot is discarded, which is the point when an
 * upgrade has migrated a database beyond what the old version can read.
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
      "sh", "-c",
      // Clear first so files created after the snapshot do not survive a
      // restore and confuse the older version.
      `set -e; rm -rf /dst/* /dst/.[!.]* 2>/dev/null || true; tar xzf /backup/${CONFIG_SNAPSHOT_FILE} -C /dst`
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

  const root = path.join(settings.stackRoot, ".stackarr-backups", serviceId);
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
  const backupDir = path.join(settings.stackRoot, ".stackarr-backups", service.id, timestamp);
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
  const serviceBackupRoot = path.join(settings.stackRoot, ".stackarr-backups", service.id);
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
    return "That host port is already in use by another container or service.";
  }

  if (/pull access denied|authentication required/i.test(text)) {
    return "The registry refused the pull. The image may be private or the tag may have been removed.";
  }

  return null;
}

export async function generateAndDeploy(settings, service, options = {}) {
  return runCommand(settings.dockerBin, composeArgs(service, "up", "-d"), {
    logger: options.logger
  });
}

export async function installService(settings, service, options = {}) {
  await backupService(settings, service, options);
  return generateAndDeploy(settings, service, options);
}

export async function upgradeService(settings, service, options = {}) {
  await backupService(settings, service, options);

  const pullResult = await runCommand(settings.dockerBin, composeArgs(service, "pull"), {
    logger: options.logger
  });
  if (!pullResult.ok) {
    return pullResult;
  }

  const upResult = await runCommand(settings.dockerBin, composeArgs(service, "up", "-d"), {
    logger: options.logger
  });
  return {
    ok: upResult.ok,
    code: upResult.code,
    stdout: `${pullResult.stdout}\n${upResult.stdout}`.trim(),
    stderr: `${pullResult.stderr}\n${upResult.stderr}`.trim()
  };
}

export async function checkForUpdates(settings, service, options = {}) {
  const result = await runCommand(settings.dockerBin, composeArgs(service, "pull"), {
    logger: options.logger
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
