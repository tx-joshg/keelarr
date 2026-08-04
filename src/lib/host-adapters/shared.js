import { access, constants } from "node:fs/promises";

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

export async function probeDockerCandidate(binaryPath) {
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
      timeoutMs: 8_000
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
      timeoutMs: 8_000
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

export async function firstSuccessfulDockerProbe(candidates) {
  const results = [];
  const seen = new Set();

  for (const candidate of candidates.filter(Boolean)) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    const probe = await probeDockerCandidate(candidate);
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

