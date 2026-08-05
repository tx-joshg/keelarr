import {
  confidenceFromScore,
  field,
  firstSuccessfulDockerProbe,
  pathCreatable,
  pathExists,
  validateDockerHostProfile
} from "./shared.js";

const QNAP_DOCKER_BINS = [
  "/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker",
  "/share/CACHEDEV1_DATA/.qpkg/container-station/usr/bin/docker",
  "/usr/bin/docker",
  "docker"
];

export async function detectQnapHost(settings = {}, options = {}) {
  const dockerProbe = await firstSuccessfulDockerProbe([settings.dockerBin, ...QNAP_DOCKER_BINS], options);
  const stackRoot = "/share/Container/docker";
  const configRoot = "/share/Container";
  const mediaRoot = "/share/Media";
  const downloadsRoot = "/share/Media/Downloads";
  const plexLogsRoot = "/share/Container/plex/Logs";

  const [
    qnapDockerBinExists,
    qnapDockerUsrBinExists,
    stackRootExists,
    stackRootWritable,
    configRootExists,
    mediaRootExists,
    downloadsRootExists,
    plexLogsExists
  ] = await Promise.all([
    pathExists("/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker"),
    pathExists("/share/CACHEDEV1_DATA/.qpkg/container-station/usr/bin/docker"),
    pathExists(stackRoot),
    pathCreatable(stackRoot),
    pathExists(configRoot),
    pathExists(mediaRoot),
    pathExists(downloadsRoot),
    pathExists(plexLogsRoot)
  ]);
  const qnapDockerExists = qnapDockerBinExists || qnapDockerUsrBinExists;
  const resolvedDockerBin = dockerProbe.selected?.binaryPath
    || (qnapDockerBinExists
      ? "/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker"
      : qnapDockerUsrBinExists
        ? "/share/CACHEDEV1_DATA/.qpkg/container-station/usr/bin/docker"
        : "docker");
  const qnapSharesDetected = configRootExists && mediaRootExists;
  const dockerNote = qnapDockerExists
    ? "QNAP Container Station docker binary was found."
    : qnapSharesDetected && dockerProbe.selected?.composeOk
      ? `QNAP shares were detected and Docker Compose validated via ${resolvedDockerBin}.`
      : "QNAP Container Station docker binary was not found at the common path.";

  let score = 0;
  if (qnapDockerExists) {
    score += 30;
  }
  if (configRootExists && mediaRootExists) {
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
      dockerNote,
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
      dockerBin: resolvedDockerBin,
      stackRoot,
      configRoot,
      mediaRoot,
      downloadsRoot,
      plexLogsRoot: plexLogsExists ? plexLogsRoot : ""
    },
    fieldSuggestions: {
      dockerBin: field(resolvedDockerBin, dockerProbe.selected?.composeOk ? "high" : qnapDockerExists ? "medium" : "low", qnapDockerExists ? "qnap-detection" : "validated-command"),
      stackRoot: field(stackRoot, stackRootExists ? "high" : "medium", stackRootExists ? "existing-qnap-path" : "qnap-default"),
      configRoot: field(configRoot, configRootExists ? "high" : "medium", "qnap-default"),
      mediaRoot: field(mediaRoot, mediaRootExists ? "high" : "medium", "qnap-default"),
      downloadsRoot: field(downloadsRoot, downloadsRootExists ? "high" : "medium", "qnap-default"),
      plexLogsRoot: field(plexLogsExists ? plexLogsRoot : "", plexLogsExists ? "high" : "low", plexLogsExists ? "existing-qnap-path" : "unset")
    },
    diagnostics: dockerProbe.probes
  };
}

export async function validateQnapHost(settings = {}, options = {}) {
  return validateDockerHostProfile(settings, {
    ...options,
    adapterId: "qnap",
    label: "QNAP / Container Station",
    dockerCandidates: [settings.dockerBin || "/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker"]
  });
}

export const qnapHostAdapter = {
  id: "qnap",
  label: "QNAP / Container Station",
  detect: detectQnapHost,
  validate: validateQnapHost
};
