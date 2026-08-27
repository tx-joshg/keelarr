import { APP_VERSION } from "../app-meta.js";
import { DATA_MOUNT, DEPLOY_MOUNT, DOCKER_SOCKET_MOUNT, findMount } from "../host-mounts.js";
import { readControllerUpdateState, writeControllerUpdateState } from "../store.js";
import { defaultLogger } from "../logger.js";

const RELEASES_URL = "https://api.github.com/repos/tx-joshg/keelarr/releases/latest";
const PUBLISHED_IMAGE_PREFIX = "ghcr.io/tx-joshg/keelarr";
// Long enough that a dead network cannot stall a dashboard render, short enough
// that a slow answer is still worth waiting for.
const RELEASE_TIMEOUT_MS = 8_000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Strips a leading v so a git tag and a package version can be compared.
 * `readImageVersionLabel` does the same thing for app images.
 */
export function normalizeVersion(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

/**
 * Compares two dotted versions numerically, so 0.1.10 sorts above 0.1.9.
 *
 * A string compare gets that backwards, and getting it backwards means telling
 * someone they are up to date when they are nine releases behind.
 */
export function compareVersions(left, right) {
  const parse = (value) => normalizeVersion(value).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);

    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }

  return 0;
}

/**
 * Reports whether Keelarr can replace its own container on this host, and what
 * the newest published release is.
 *
 * Deliberately separate from ManagedStackService: that class is built around
 * `settings.services[serviceId]` — per-service backups, config snapshots,
 * rollback points — and the controller has none of those. Folding this in would
 * put an "unless it is the controller" branch through half of it.
 */
export class SelfUpdateService {
  constructor({
    hostProfileService = null,
    jobs = null,
    logger = defaultLogger,
    fetchImpl = globalThis.fetch,
    readControllerUpdateStateImpl = readControllerUpdateState,
    writeControllerUpdateStateImpl = writeControllerUpdateState,
    nowImpl = () => Date.now(),
    appVersion = APP_VERSION,
    releasesUrl = RELEASES_URL
  } = {}) {
    this.hostProfileService = hostProfileService;
    this.jobs = jobs;
    this.logger = logger;
    this.fetch = fetchImpl;
    this.readControllerUpdateState = readControllerUpdateStateImpl;
    this.writeControllerUpdateState = writeControllerUpdateStateImpl;
    this.now = nowImpl;
    this.appVersion = appVersion;
    this.releasesUrl = releasesUrl;
  }

  scopedLogger(context = {}) {
    return context.requestId ? this.logger.child({ requestId: context.requestId }) : this.logger;
  }

  /**
   * Every reason the controller could not replace itself, each carrying its own
   * message so the UI prints what was actually found rather than mapping ids to
   * a second copy of these sentences.
   */
  buildChecks(controller, { jobRunning = false } = {}) {
    const mounts = controller?.mounts || [];
    const image = controller?.image || "";
    const configFiles = controller?.configFiles || [];

    return [
      {
        id: "container",
        label: "Keelarr can see its own container",
        ok: Boolean(controller?.containerName),
        reason: "Keelarr cannot see its own container, so it cannot replace it."
      },
      {
        id: "socket",
        label: "The Docker socket is mounted",
        ok: Boolean(findMount(mounts, DOCKER_SOCKET_MOUNT)),
        reason: "The Docker socket is not mounted into Keelarr."
      },
      {
        id: "compose",
        label: "The container was created by Compose",
        ok: Boolean(controller?.projectName) && configFiles.length > 0,
        reason: "Keelarr's container was not created by Docker Compose, so there is no project to recreate it from."
      },
      {
        id: "service-label",
        label: "Compose recorded which service this is",
        ok: Boolean(controller?.serviceName),
        reason: "Compose did not record which service Keelarr is, so a recreate could act on the wrong one."
      },
      {
        id: "deploy-mount",
        label: "The deploy directory is mounted",
        ok: Boolean(findMount(mounts, DEPLOY_MOUNT)),
        reason: `The deploy directory is not mounted. Add ./:${DEPLOY_MOUNT} and recreate the controller.`
      },
      {
        id: "data-mount",
        label: "The data directory is mounted",
        ok: Boolean(findMount(mounts, DATA_MOUNT)),
        reason: "The data directory is not mounted, so the result of an update could not survive the restart."
      },
      {
        id: "published-image",
        label: "Running a published image",
        ok: image.startsWith(PUBLISHED_IMAGE_PREFIX),
        reason: image
          ? `Keelarr is running ${image}, which is not a published image. Self-update only applies to images from ${PUBLISHED_IMAGE_PREFIX}.`
          : "Keelarr could not read its own image reference."
      },
      {
        id: "idle",
        label: "Nothing else is running",
        ok: !jobRunning,
        reason: "Another operation is running. Restarting Keelarr in the middle of it would leave that half-finished."
      }
    ];
  }

  /**
   * Cheap enough for every dashboard render: one container inspect and one file
   * read, and never a network call. Discovery happens in checkSelfUpdate.
   */
  async describeSelfUpdate(context = {}) {
    const logger = this.scopedLogger(context);
    const settings = await this.hostProfileService.loadSettings();
    let controller = null;

    try {
      controller = await this.hostProfileService.readControllerDefinition(settings, logger);
    } catch (error) {
      logger.warn("self_update.controller_unreadable", { error: error.message });
    }

    const jobRunning = Boolean(this.jobs?.list().some((job) => job.status === "running" || job.status === "pending"));
    const checks = this.buildChecks(controller, { jobRunning });
    const blocked = checks.find((check) => !check.ok) || null;
    const state = await this.readControllerUpdateState();
    const currentVersion = normalizeVersion(this.appVersion);
    const targetVersion = normalizeVersion(state.latestVersion);
    const behind = targetVersion ? compareVersions(currentVersion, targetVersion) < 0 : false;

    return {
      currentVersion,
      targetVersion: targetVersion || null,
      // "current" is only claimed when a check actually said so.
      updateStatus: state.checkedAt ? (behind ? "ready" : "current") : "unchecked",
      checkedAt: state.checkedAt || null,
      checkError: state.error || null,
      supported: !blocked,
      available: Boolean(behind) && !blocked,
      reason: blocked?.reason || null,
      checks
    };
  }

  /**
   * Asks GitHub for the newest release. Nothing is downloaded.
   *
   * The release tag, not the `latest` image tag: deploy/.env pins an exact
   * version and renderControllerEnv carries that pin across every settings
   * save, so discovery has to produce a version number rather than move the
   * install onto a floating tag.
   */
  async checkSelfUpdate(context = {}) {
    const logger = this.scopedLogger(context);
    const state = await this.readControllerUpdateState();
    let next;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RELEASE_TIMEOUT_MS);
      let response;

      try {
        response = await this.fetch(this.releasesUrl, {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "keelarr" },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw new Error(`GitHub answered ${response.status}.`);
      }

      const body = await response.json();
      const latestVersion = normalizeVersion(body?.tag_name);

      if (!latestVersion) {
        throw new Error("The newest release has no version tag.");
      }

      next = {
        ...state,
        latestVersion,
        releaseUrl: body?.html_url || null,
        checkedAt: new Date(this.now()).toISOString(),
        error: null
      };
      logger.info("self_update.checked", { latestVersion, currentVersion: normalizeVersion(this.appVersion) });
    } catch (error) {
      // A failed check must not read as "up to date". The previous answer is
      // kept, the failure is recorded beside it, and the UI says which it is.
      next = {
        ...state,
        checkedAt: state.checkedAt || null,
        error: error.name === "AbortError" ? "GitHub did not answer in time." : error.message
      };
      logger.warn("self_update.check_failed", { error: next.error });
    }

    await this.writeControllerUpdateState(next);
    return this.describeSelfUpdate(context);
  }

  /** Whether a scheduled check is due, mirroring isUpdateCheckDue for services. */
  isCheckDue(state, { now = this.now(), intervalMs = CHECK_INTERVAL_MS } = {}) {
    const last = state?.checkedAt;

    if (!last) {
      return true;
    }

    const parsed = Date.parse(last);

    return !Number.isFinite(parsed) || now - parsed >= intervalMs;
  }
}
