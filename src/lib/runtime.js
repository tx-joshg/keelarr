import { copyFile, mkdir, writeFile } from "node:fs/promises";
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

export async function backupService(settings, service, options = {}) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
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

  return backupDir;
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
  let status = "unknown";

  if (/Downloaded newer image/i.test(combinedOutput)) {
    status = "ready";
  } else if (/Image is up to date|up to date/i.test(combinedOutput)) {
    status = "current";
  }

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
