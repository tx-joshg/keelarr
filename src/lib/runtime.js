import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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

export function buildRollbackRecord(service, { imageId, imageRepoDigest, backedUpAt }) {
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
    backedUpAt
  };
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
  const rollback = buildRollbackRecord(service, {
    imageId,
    imageRepoDigest: await readImageRepoDigest(settings, imageId, options),
    backedUpAt
  });
  await writeFile(path.join(backupDir, "rollback.json"), `${JSON.stringify(rollback, null, 2)}\n`, "utf8");

  options.logger?.info("service.backup", {
    serviceId: service.id,
    containerName: service.containerName,
    backupDir,
    imageId: rollback.imageId,
    imageRepoDigest: rollback.imageRepoDigest
  });

  return {
    backupDir,
    rollback
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
      taggedImage: record.image || null
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
