import { access, constants } from "node:fs/promises";
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
      plexLogsRoot: result(!settings.selectedServiceIds?.includes("tautulli") || Boolean(plexLogsRoot), plexLogsRoot ? (plexLogsExists ? "info" : "warn") : settings.selectedServiceIds?.includes("tautulli") ? "warn" : "info", plexLogsRoot, plexLogsRoot ? (plexLogsExists ? "Plex logs path exists." : "Plex logs path was not found on disk.") : settings.selectedServiceIds?.includes("tautulli") ? "Plex logs path is recommended for Tautulli." : "Plex logs path is optional.")
    }
  };
}
