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

export async function backupService(settings, service) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(settings.stackRoot, ".stackarr-backups", service.id, timestamp);
  await mkdir(backupDir, { recursive: true });

  await backupFileIfPresent(service.composePath, backupDir);
  await backupFileIfPresent(service.envPath, backupDir);

  const inspectResult = await runCommand(settings.dockerBin, ["inspect", service.containerName]);
  if (inspectResult.ok) {
    await writeFile(path.join(backupDir, "inspect.json"), inspectResult.stdout, "utf8");
  }

  return backupDir;
}

export async function composePs(settings, service) {
  const result = await runCommand(settings.dockerBin, composeArgs(service, "ps", "--format", "json"));

  if (!result.ok) {
    return {
      ok: false,
      error: result.stderr || result.stdout || "Unable to query compose status."
    };
  }

  try {
    const parsed = JSON.parse(result.stdout || "[]");
    return { ok: true, data: parsed };
  } catch {
    return {
      ok: false,
      error: "Compose returned invalid JSON."
    };
  }
}

export async function generateAndDeploy(settings, service) {
  return runCommand(settings.dockerBin, composeArgs(service, "up", "-d"));
}

export async function installService(settings, service) {
  await backupService(settings, service);
  return generateAndDeploy(settings, service);
}

export async function upgradeService(settings, service) {
  await backupService(settings, service);

  const pullResult = await runCommand(settings.dockerBin, composeArgs(service, "pull"));
  if (!pullResult.ok) {
    return pullResult;
  }

  const upResult = await runCommand(settings.dockerBin, composeArgs(service, "up", "-d"));
  return {
    ok: upResult.ok,
    code: upResult.code,
    stdout: `${pullResult.stdout}\n${upResult.stdout}`.trim(),
    stderr: `${pullResult.stderr}\n${upResult.stderr}`.trim()
  };
}

export async function checkForUpdates(settings, service) {
  const result = await runCommand(settings.dockerBin, composeArgs(service, "pull"));
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

export async function upgradeAllServices(settings, services) {
  const results = [];

  for (const service of services) {
    results.push({
      serviceId: service.id,
      ...(await upgradeService(settings, service))
    });
  }

  return results;
}
