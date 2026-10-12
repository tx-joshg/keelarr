import { dockerRuntime } from "./docker-runtime.js";
import { kubeRuntime } from "./kube-runtime.js";

/**
 * The runtime port.
 *
 * Every operation below takes `settings` first, which is the whole reason this
 * seam is cheap: the runtime a call belongs to is already in its first
 * argument, so dispatch is one lookup rather than threading a runtime object
 * through ten services.
 *
 * Callers import from here rather than from a runtime directly. Nothing outside
 * this directory should know which runtime is in use — that was the property
 * that made a second one possible, and it is worth keeping.
 */
export const RUNTIME_KIND = Object.freeze({
  /** Compose files on a host, driven by `docker`. The proven path. */
  DOCKER: "docker",
  /** Manifests in a namespace, driven by `oc` or `kubectl`. */
  KUBE: "kube"
});

const RUNTIMES = {
  [RUNTIME_KIND.DOCKER]: dockerRuntime,
  [RUNTIME_KIND.KUBE]: kubeRuntime
};

/**
 * Which runtime a settings object describes.
 *
 * Defaults to Docker, deliberately and permanently: every existing install has
 * no `runtime` key at all, and the only safe reading of its absence is the
 * runtime that install has been using all along.
 */
export function runtimeFor(settings = {}) {
  return RUNTIMES[settings?.runtime] || dockerRuntime;
}

export function runtimeKindFor(settings = {}) {
  return runtimeFor(settings).kind;
}

/**
 * Pure helpers and constants, which describe Compose and image semantics rather
 * than performing anything. Re-exported unchanged rather than dispatched: there
 * is no second answer to what a Compose `ps` payload looks like.
 */
export {
  CONFIG_SNAPSHOT_EXCLUDES,
  CONFIG_SNAPSHOT_FILE,
  buildConfigRestoreScript,
  buildRollbackRecord,
  deriveUpdateStatusFromPullResult,
  explainDeployFailure,
  normalizeComposePsData,
  normalizeImageId
} from "./docker-runtime.js";

// --- dispatched operations ---
export const readConfigMountSource = (settings, ...rest) => runtimeFor(settings).readConfigMountSource(settings, ...rest);
export const inspectContainers = (settings, ...rest) => runtimeFor(settings).inspectContainers(settings, ...rest);
export const readContainerFile = (settings, ...rest) => runtimeFor(settings).readContainerFile(settings, ...rest);
export const snapshotConfig = (settings, ...rest) => runtimeFor(settings).snapshotConfig(settings, ...rest);
export const restoreConfigSnapshot = (settings, ...rest) => runtimeFor(settings).restoreConfigSnapshot(settings, ...rest);
export const pruneServiceBackups = (settings, ...rest) => runtimeFor(settings).pruneServiceBackups(settings, ...rest);
export const backupService = (settings, ...rest) => runtimeFor(settings).backupService(settings, ...rest);
export const stopContainer = (settings, ...rest) => runtimeFor(settings).stopContainer(settings, ...rest);
export const startContainer = (settings, ...rest) => runtimeFor(settings).startContainer(settings, ...rest);
export const renameContainer = (settings, ...rest) => runtimeFor(settings).renameContainer(settings, ...rest);
export const removeContainer = (settings, ...rest) => runtimeFor(settings).removeContainer(settings, ...rest);
export const containerExists = (settings, ...rest) => runtimeFor(settings).containerExists(settings, ...rest);
export const inspectContainerState = (settings, ...rest) => runtimeFor(settings).inspectContainerState(settings, ...rest);
export const composeDown = (settings, ...rest) => runtimeFor(settings).composeDown(settings, ...rest);
export const findRollbackPoint = (settings, ...rest) => runtimeFor(settings).findRollbackPoint(settings, ...rest);
export const imageExistsLocally = (settings, ...rest) => runtimeFor(settings).imageExistsLocally(settings, ...rest);
export const composeDownRemovingVolumes = (settings, ...rest) => runtimeFor(settings).composeDownRemovingVolumes(settings, ...rest);
export const removeImage = (settings, ...rest) => runtimeFor(settings).removeImage(settings, ...rest);
export const measurePath = (settings, ...rest) => runtimeFor(settings).measurePath(settings, ...rest);
export const restartService = (settings, ...rest) => runtimeFor(settings).restartService(settings, ...rest);
export const composePs = (settings, ...rest) => runtimeFor(settings).composePs(settings, ...rest);
export const ensureSharedNetwork = (settings, ...rest) => runtimeFor(settings).ensureSharedNetwork(settings, ...rest);
export const generateAndDeploy = (settings, ...rest) => runtimeFor(settings).generateAndDeploy(settings, ...rest);
export const installService = (settings, ...rest) => runtimeFor(settings).installService(settings, ...rest);
export const upgradeService = (settings, ...rest) => runtimeFor(settings).upgradeService(settings, ...rest);
export const pullImage = (settings, ...rest) => runtimeFor(settings).pullImage(settings, ...rest);
export const readImageId = (settings, ...rest) => runtimeFor(settings).readImageId(settings, ...rest);
export const readContainerImageIdByName = (settings, ...rest) => runtimeFor(settings).readContainerImageIdByName(settings, ...rest);
export const tagImage = (settings, ...rest) => runtimeFor(settings).tagImage(settings, ...rest);
export const readContainerLogs = (settings, ...rest) => runtimeFor(settings).readContainerLogs(settings, ...rest);
export const readContainerOutcome = (settings, ...rest) => runtimeFor(settings).readContainerOutcome(settings, ...rest);
export const runDetachedContainer = (settings, ...rest) => runtimeFor(settings).runDetachedContainer(settings, ...rest);
export const checkForUpdates = (settings, ...rest) => runtimeFor(settings).checkForUpdates(settings, ...rest);
export const upgradeAllServices = (settings, ...rest) => runtimeFor(settings).upgradeAllServices(settings, ...rest);
export const readNetworkDrivers = (settings, ...rest) => runtimeFor(settings).readNetworkDrivers(settings, ...rest);
export const attachController = (settings, ...rest) => runtimeFor(settings).attachController(settings, ...rest);
