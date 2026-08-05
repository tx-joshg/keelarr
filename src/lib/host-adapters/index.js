import { genericDockerHostAdapter } from "./generic-docker.js";
import { qnapHostAdapter } from "./qnap.js";

const HOST_ADAPTERS = [
  qnapHostAdapter,
  genericDockerHostAdapter
];

export function listHostAdapters() {
  return HOST_ADAPTERS;
}

export function getHostAdapter(adapterId) {
  return HOST_ADAPTERS.find((adapter) => adapter.id === adapterId) || null;
}

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

export async function detectHostEnvironment(settings = {}, options = {}) {
  const detections = await Promise.all(HOST_ADAPTERS.map((adapter) => adapter.detect(settings, options)));
  const selected = pickBestHostDetection(detections);

  return {
    selected,
    detections
  };
}

export async function validateHostProfile(settings = {}, options = {}) {
  const adapter = getHostAdapter(settings.adapterType) || genericDockerHostAdapter;
  return adapter.validate(settings, options);
}
