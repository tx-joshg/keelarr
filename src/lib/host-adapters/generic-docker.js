import { mountedRootsFromEnv } from "../host-mounts.js";
import {
  confidenceFromScore,
  field,
  firstSuccessfulDockerProbe,
  pathCreatable,
  pathExists,
  validateDockerHostProfile
} from "./shared.js";

export function resolveGenericDockerSuggestedPaths(settings = {}, options = {}) {
  const resetToGenericDefaults = options.preferredAdapterId === "generic-docker" && settings.adapterType !== "generic-docker";
  // What this controller was actually mounted with beats a generic guess: a
  // suggestion the container cannot see is one the operator has to correct
  // before anything works.
  const mounted = options.mountedRoots || mountedRootsFromEnv();
  // Before the first save, the values in settings are placeholders nobody
  // picked, so a real mount outranks them. Afterwards they are the operator's
  // decision and re-detecting must not quietly overwrite it.
  const settingsAreChosen = settings.initialized === true;
  const pick = (field, fallback) => {
    // Switching away from another host profile discards its paths outright —
    // that is what makes it a reset — so settings are not consulted at all.
    if (resetToGenericDefaults) {
      return mounted[field] || fallback;
    }

    if (!settingsAreChosen) {
      return mounted[field] || settings[field] || fallback;
    }

    return settings[field] || mounted[field] || fallback;
  };
  const mediaRoot = pick("mediaRoot", "/srv/media");

  return {
    stackRoot: pick("stackRoot", "/opt/stackarr/stacks"),
    configRoot: pick("configRoot", "/srv/stackarr/config"),
    mediaRoot,
    downloadsRoot: pick("downloadsRoot", `${mediaRoot}/downloads`),
    // Only Tautulli uses this, so an unset value is a normal end state rather
    // than something to invent a path for.
    plexLogsRoot: pick("plexLogsRoot", "")
  };
}

export async function detectGenericDockerHost(settings = {}, options = {}) {
  const dockerCandidates = [settings.dockerBin, process.env.DOCKER_BIN, "docker"];
  const dockerProbe = await firstSuccessfulDockerProbe(dockerCandidates, options);
  const {
    stackRoot,
    configRoot,
    mediaRoot,
    downloadsRoot,
    plexLogsRoot
  } = resolveGenericDockerSuggestedPaths(settings, options);

  const mounted = options.mountedRoots || mountedRootsFromEnv();
  // Naming the origin matters here: "mounted-root" tells the operator this is
  // the path the controller can genuinely reach, not a guess to be corrected.
  const sourceFor = (fieldName, value, exists) => {
    if (mounted[fieldName] === value) {
      return "mounted-root";
    }

    return exists ? "existing-path" : "generic-default";
  };

  const [stackExists, stackWritable, mediaExists] = await Promise.all([
    pathExists(stackRoot),
    pathCreatable(stackRoot),
    pathExists(mediaRoot)
  ]);

  let score = 0;
  if (dockerProbe.selected?.dockerOk) {
    score += 35;
  }
  if (dockerProbe.selected?.composeOk) {
    score += 30;
  }
  if (stackExists) {
    score += 10;
  }
  if (stackWritable) {
    score += 10;
  }
  if (mediaExists) {
    score += 10;
  }

  return {
    adapterId: "generic-docker",
    label: "Generic Docker Host",
    matched: Boolean(dockerProbe.selected?.dockerOk),
    score,
    confidence: confidenceFromScore(score),
    notes: [
      dockerProbe.selected?.composeOk ? "Docker Compose is available." : "Docker Compose could not be validated.",
      stackExists ? "Stack root already exists." : "Stack root does not exist yet and will need to be created."
    ],
    validation: {
      dockerOk: dockerProbe.selected?.dockerOk === true,
      composeOk: dockerProbe.selected?.composeOk === true,
      stackRootWritable: stackWritable
    },
    suggestedSettings: {
      adapterType: "generic-docker",
      hostLabel: "Generic Docker Host",
      dockerBin: dockerProbe.selected?.binaryPath || "docker",
      stackRoot,
      configRoot,
      mediaRoot,
      downloadsRoot,
      plexLogsRoot
    },
    fieldSuggestions: {
      dockerBin: field(dockerProbe.selected?.binaryPath || "docker", dockerProbe.selected?.composeOk ? "high" : "medium", "validated-command"),
      stackRoot: field(stackRoot, stackWritable ? "high" : "medium", sourceFor("stackRoot", stackRoot, stackExists)),
      configRoot: field(configRoot, mounted.configRoot ? "high" : "medium", sourceFor("configRoot", configRoot, false)),
      mediaRoot: field(mediaRoot, mediaExists || mounted.mediaRoot ? "medium" : "low", sourceFor("mediaRoot", mediaRoot, mediaExists)),
      downloadsRoot: field(downloadsRoot, "medium", "derived-default"),
      plexLogsRoot: field(plexLogsRoot, plexLogsRoot ? "manual" : "low", plexLogsRoot ? "user-provided" : "unset")
    },
    diagnostics: dockerProbe.probes
  };
}

export async function validateGenericDockerHost(settings = {}, options = {}) {
  return validateDockerHostProfile(settings, {
    ...options,
    adapterId: "generic-docker",
    label: "Generic Docker Host",
    dockerCandidates: [settings.dockerBin || "docker"]
  });
}

export const genericDockerHostAdapter = {
  id: "generic-docker",
  label: "Generic Docker Host",
  detect: detectGenericDockerHost,
  validate: validateGenericDockerHost
};
