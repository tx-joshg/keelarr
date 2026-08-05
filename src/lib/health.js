import { inspectContainerState } from "./runtime.js";

export const HEALTH_OUTCOME = Object.freeze({
  /** Container is up and something actively confirmed it works. */
  VERIFIED: "verified",
  /** Container is running, but nothing could confirm the app responds. */
  UNVERIFIED: "unverified",
  /** Container is gone, exited, or never came up. */
  FAILED: "failed"
});

const DEAD_STATUSES = new Set(["exited", "dead", "removing"]);

const PROBE_TIMEOUT_MS = 1500;
// A reachable app answers fast; re-checking every refresh adds nothing.
const PROBE_OK_TTL_MS = 20_000;
// A failure is usually structural — a bridge-networked container cannot reach
// the host's published ports at all — so re-probing it every few seconds just
// burns the timeout again. Back off harder on failure than on success.
const PROBE_FAIL_TTL_MS = 90_000;

const probeCache = new Map();

export function clearProbeCache() {
  probeCache.clear();
}

export async function probeAppUrl(service, options = {}) {
  const now = options.nowImpl ? options.nowImpl() : Date.now();
  const cached = probeCache.get(service.appUrl);

  if (cached && now - cached.at < (cached.value.reachable ? PROBE_OK_TTL_MS : PROBE_FAIL_TTL_MS)) {
    return cached.value;
  }

  let value;

  try {
    const startedAt = Date.now();
    const response = await fetch(service.appUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });

    value = {
      reachable: service.healthStatuses.includes(response.status),
      latencyMs: Date.now() - startedAt,
      httpStatus: response.status
    };
  } catch (error) {
    value = {
      reachable: false,
      latencyMs: null,
      httpStatus: null,
      error: error.message
    };
  }

  probeCache.set(service.appUrl, { at: now, value });
  return value;
}

/**
 * Turns one observation into a verdict.
 *
 * `pending` means "not decided yet, keep polling" — it is deliberately
 * distinct from `failed`, because a container that is starting, restarting, or
 * briefly unhealthy may still settle. Only the deadline converts a pending
 * observation into a final answer.
 */
export function classifyHealthSnapshot(state, probe = null) {
  if (!state.exists) {
    return { outcome: "pending", reason: "Container not found yet." };
  }

  if (DEAD_STATUSES.has(state.status)) {
    return { outcome: HEALTH_OUTCOME.FAILED, reason: `Container is ${state.status}.` };
  }

  if (state.healthStatus === "healthy") {
    return { outcome: HEALTH_OUTCOME.VERIFIED, reason: "Container healthcheck reports healthy." };
  }

  if (state.healthStatus === "unhealthy") {
    return { outcome: "pending", reason: "Container healthcheck reports unhealthy." };
  }

  if (state.healthStatus === "starting") {
    return { outcome: "pending", reason: "Container healthcheck is still starting." };
  }

  if (state.status !== "running") {
    return { outcome: "pending", reason: `Container is ${state.status || "in an unknown state"}.` };
  }

  if (probe?.reachable) {
    return { outcome: HEALTH_OUTCOME.VERIFIED, reason: `App responded with HTTP ${probe.httpStatus}.` };
  }

  // Running with no healthcheck and no usable HTTP answer. This is the honest
  // middle ground: the container is up, but nothing proves the app works.
  return {
    outcome: "running-unverified",
    reason: probe?.error
      ? `Container is running but the app URL did not respond (${probe.error}).`
      : probe === null
        ? "Container is running. No healthcheck, and the app URL is not reachable from the controller, so health could not be confirmed."
        : "Container is running but no healthcheck or app response confirmed it."
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A loopback app URL is meaningless from inside the controller container:
 * localhost is the controller, not the host. Probing it always fails, which
 * would report every healthy service as unverified.
 */
export function isProbeableAppUrl(value) {
  if (!value) {
    return false;
  }

  try {
    return !["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * Polls until the service is confirmed healthy, confirmed dead, or the
 * deadline passes. A container that is merely running when time runs out
 * resolves to `unverified` rather than success, so the caller can decide
 * whether to keep the rollback container in place.
 */
export async function verifyServiceHealth(settings, service, options = {}) {
  const {
    timeoutMs = 90_000,
    intervalMs = 2_000,
    inspectImpl = inspectContainerState,
    probeImpl = probeAppUrl,
    sleepImpl = sleep,
    nowImpl = () => Date.now(),
    logger = null
  } = options;

  const deadline = nowImpl() + timeoutMs;
  let last = { outcome: "pending", reason: "No observation recorded." };
  let lastState = { exists: false, status: null, healthStatus: null };
  let lastProbe = null;
  let attempts = 0;

  while (true) {
    attempts += 1;
    lastState = await inspectImpl(settings, service.containerName, { logger });
    lastProbe = lastState.exists && lastState.status === "running" && isProbeableAppUrl(service.appUrl)
      ? await probeImpl(service)
      : null;
    last = classifyHealthSnapshot(lastState, lastProbe);

    if (last.outcome === HEALTH_OUTCOME.VERIFIED || last.outcome === HEALTH_OUTCOME.FAILED) {
      break;
    }

    if (nowImpl() >= deadline) {
      // Ran out of time. Running-but-unproven is reported as such; anything
      // else never came up and counts as a failure.
      last = last.outcome === "running-unverified"
        ? { outcome: HEALTH_OUTCOME.UNVERIFIED, reason: last.reason }
        : { outcome: HEALTH_OUTCOME.FAILED, reason: `${last.reason} Timed out after ${timeoutMs}ms.` };
      break;
    }

    await sleepImpl(intervalMs);
  }

  return {
    outcome: last.outcome,
    reason: last.reason,
    attempts,
    status: lastState.status,
    healthStatus: lastState.healthStatus,
    httpStatus: lastProbe?.httpStatus ?? null
  };
}
