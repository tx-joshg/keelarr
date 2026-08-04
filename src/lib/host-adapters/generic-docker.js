import { confidenceFromScore, field, firstSuccessfulDockerProbe, pathExists, pathWritable } from "./shared.js";

export async function detectGenericDockerHost(settings = {}) {
  const dockerCandidates = [settings.dockerBin, process.env.DOCKER_BIN, "docker"];
  const dockerProbe = await firstSuccessfulDockerProbe(dockerCandidates);
  const stackRoot = settings.stackRoot || "/opt/stackarr/stacks";
  const configRoot = settings.configRoot || "/srv/stackarr/config";
  const mediaRoot = settings.mediaRoot || "/srv/media";
  const downloadsRoot = settings.downloadsRoot || `${mediaRoot}/downloads`;
  const plexLogsRoot = settings.plexLogsRoot || "";

  const [stackExists, stackWritable, mediaExists] = await Promise.all([
    pathExists(stackRoot),
    pathWritable(stackRoot),
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
      stackRoot: field(stackRoot, stackWritable ? "high" : "medium", stackExists ? "existing-path" : "generic-default"),
      configRoot: field(configRoot, "medium", "generic-default"),
      mediaRoot: field(mediaRoot, mediaExists ? "medium" : "low", mediaExists ? "existing-path" : "generic-default"),
      downloadsRoot: field(downloadsRoot, "medium", "derived-default"),
      plexLogsRoot: field(plexLogsRoot, plexLogsRoot ? "manual" : "low", plexLogsRoot ? "user-provided" : "unset")
    },
    diagnostics: dockerProbe.probes
  };
}

