import { detectGenericDockerHost } from "./generic-docker.js";
import { detectQnapHost } from "./qnap.js";

export function pickBestHostDetection(detections) {
  return [...detections].sort((left, right) => right.score - left.score)[0];
}

export function applyDetectionSuggestions(settings, detection) {
  if (!detection?.suggestedSettings) {
    return settings;
  }

  return {
    ...settings,
    ...detection.suggestedSettings
  };
}

export async function detectHostEnvironment(settings = {}) {
  const detections = await Promise.all([
    detectQnapHost(settings),
    detectGenericDockerHost(settings)
  ]);
  const selected = pickBestHostDetection(detections);

  return {
    selected,
    detections
  };
}

