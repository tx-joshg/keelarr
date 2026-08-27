import { KeelarrError } from "./errors.js";

// Long enough for a pull, a recreate and two health windows; short enough that
// a controller killed mid-update cannot wedge the stack until someone notices.
const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * A single "nothing else may change the stack right now" claim.
 *
 * The job registry already refuses a second job for the same kind and subject,
 * but that is per-subject by design: two different services can be upgraded at
 * once, and should be. Replacing the controller is the one operation where that
 * is wrong — it takes down the process running every other job, so a cutover
 * started a second later would be killed halfway, leaving a container renamed
 * and stopped with nothing left running to finish or revert it.
 *
 * Deliberately not a job: the thing being excluded is *starting* a job at all,
 * and that decision has to be available before any job exists.
 */
export class MutationLease {
  constructor({ nowImpl = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
    this.now = nowImpl;
    this.ttlMs = ttlMs;
    this.held = null;
  }

  /** The live claim, forgetting one that has outlived its term. */
  current() {
    if (!this.held) {
      return null;
    }

    if (this.now() - this.held.takenAt >= this.ttlMs) {
      this.held = null;
      return null;
    }

    return this.held;
  }

  isHeld() {
    return this.current() !== null;
  }

  acquire({ reason, operationId = null }) {
    const existing = this.current();

    if (existing) {
      throw new KeelarrError(`${existing.reason} is already running.`, {
        statusCode: 409,
        details: { operationId: existing.operationId }
      });
    }

    this.held = { reason, operationId, takenAt: this.now() };

    return this.held;
  }

  release(operationId = null) {
    if (!this.held) {
      return false;
    }

    // A late release from a superseded attempt must not free the current one.
    if (operationId && this.held.operationId && this.held.operationId !== operationId) {
      return false;
    }

    this.held = null;

    return true;
  }

  /**
   * Refuses a mutation while the lease is held, naming what holds it. Called by
   * every entry point that changes the stack.
   */
  assertAvailable(action) {
    const existing = this.current();

    if (!existing) {
      return;
    }

    throw new KeelarrError(
      `${action} cannot start while ${existing.reason.toLowerCase()} is running. Keelarr is about to restart, and this would be left half-finished.`,
      { statusCode: 409, details: { operationId: existing.operationId } }
    );
  }
}
