import { confidenceFromScore, field, firstSuccessfulDockerProbe, pathExists, pathWritable } from "./shared.js";

const QNAP_DOCKER_BINS = [
  "/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker",
  "/share/CACHEDEV1_DATA/.qpkg/container-station/usr/bin/docker",
  "/usr/bin/docker",
  "docker"
];

export async function detectQnapHost(settings = {}) {
  const dockerProbe = await firstSuccessfulDockerProbe([settings.dockerBin, ...QNAP_DOCKER_BINS]);
  const stackRoot = "/share/Container/docker";
  const configRoot = "/share/Container";
  const mediaRoot = "/share/Media";
  const downloadsRoot = "/share/Media/Downloads";
  const plexLogsRoot = "/share/Container/plex/Logs";

  const [
    qnapDockerExists,
    stackRootExists,
    stackRootWritable,
    configRootExists,
    mediaRootExists,
    downloadsRootExists,
    plexLogsExists
  ] = await Promise.all([
    pathExists("/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker"),
    pathExists(stackRoot),
    pathWritable("/share/Container"),
    pathExists(configRoot),
    pathExists(mediaRoot),
    pathExists(downloadsRoot),
    pathExists(plexLogsRoot)
  ]);

  let score = 0;
  if (qnapDockerExists) {
    score += 30;
  }
  if (configRootExists) {
    score += 15;
  }
  if (mediaRootExists) {
    score += 15;
  }
  if (downloadsRootExists) {
    score += 10;
  }
  if (dockerProbe.selected?.composeOk) {
    score += 20;
  } else if (dockerProbe.selected?.dockerOk) {
    score += 10;
  }
  if (stackRootWritable) {
    score += 10;
  }

  return {
    adapterId: "qnap",
    label: "QNAP / Container Station",
    matched: qnapDockerExists || (configRootExists && mediaRootExists),
    score,
    confidence: confidenceFromScore(score),
    notes: [
      qnapDockerExists ? "QNAP Container Station docker binary was found." : "QNAP Container Station docker binary was not found at the common path.",
      mediaRootExists ? "QNAP media share was detected." : "QNAP media share was not detected at /share/Media."
    ],
    validation: {
      dockerOk: dockerProbe.selected?.dockerOk === true,
      composeOk: dockerProbe.selected?.composeOk === true,
      stackRootWritable
    },
    suggestedSettings: {
      adapterType: "qnap",
      hostLabel: "QNAP NAS",
      dockerBin: dockerProbe.selected?.binaryPath || "/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker",
      stackRoot,
      configRoot,
      mediaRoot,
      downloadsRoot,
      plexLogsRoot: plexLogsExists ? plexLogsRoot : ""
    },
    fieldSuggestions: {
      dockerBin: field(dockerProbe.selected?.binaryPath || "/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker", qnapDockerExists ? "high" : "medium", "qnap-detection"),
      stackRoot: field(stackRoot, stackRootExists ? "high" : "medium", stackRootExists ? "existing-qnap-path" : "qnap-default"),
      configRoot: field(configRoot, configRootExists ? "high" : "medium", "qnap-default"),
      mediaRoot: field(mediaRoot, mediaRootExists ? "high" : "medium", "qnap-default"),
      downloadsRoot: field(downloadsRoot, downloadsRootExists ? "high" : "medium", "qnap-default"),
      plexLogsRoot: field(plexLogsExists ? plexLogsRoot : "", plexLogsExists ? "high" : "low", plexLogsExists ? "existing-qnap-path" : "unset")
    },
    diagnostics: dockerProbe.probes
  };
}

