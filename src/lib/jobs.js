import { KeelarrError } from "./errors.js";
import { defaultLogger } from "./logger.js";
import { readJobs, writeJobs } from "./store.js";

export const JOB_STATUS = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  // Work that has passed out of this process's hands — the controller updating
  // itself gives the last steps to a container that outlives it. Not terminal,
  // because the outcome is not known yet, and not running, because nothing here
  // is running it any more.
  HANDED_OFF: "handed-off",
  SUCCEEDED: "succeeded",
  FAILED: "failed"
});

export const STEP_STATUS = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  SKIPPED: "skipped"
});

const TERMINAL_JOB_STATUSES = new Set([JOB_STATUS.SUCCEEDED, JOB_STATUS.FAILED]);

function buildStep(name, label) {
  return {
    name,
    label: label || name,
    status: STEP_STATUS.PENDING,
    detail: null,
    error: null,
    startedAt: null,
    finishedAt: null
  };
}

/**
 * Public shape returned to callers. Kept explicit so the HTTP surface never
 * leaks internal handles, and so the UI can render a stable step checklist
 * from the moment the job is created.
 */
export function buildJobSnapshot(job) {
  return {
    id: job.id,
    kind: job.kind,
    subject: { ...job.subject },
    status: job.status,
    steps: job.steps.map((step) => ({ ...step })),
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt
  };
}

function subjectKey(kind, subject) {
  return `${kind}:${subject.serviceId || subject.containerId || ""}`;
}

export class JobRegistry {
  constructor({
    logger = defaultLogger,
    maxJobs = 50,
    now = () => new Date().toISOString(),
    createId = () => crypto.randomUUID(),
    // Opt-in so tests and demo runs never touch the controller's data dir.
    persist = false,
    readJobsImpl = readJobs,
    writeJobsImpl = writeJobs
  } = {}) {
    this.logger = logger.child({ component: "job-registry" });
    this.maxJobs = maxJobs;
    this.now = now;
    this.createId = createId;
    this.persist = persist;
    this.readJobs = readJobsImpl;
    this.writeJobs = writeJobsImpl;
    this.writeQueue = Promise.resolve();
    this.jobs = new Map();
    // Completion promises for jobs currently in flight, so a caller can wait
    // for one rather than poll. Cleared as each job settles, and never
    // serialized — persistence goes through buildJobSnapshot, which names its
    // fields.
    this.inFlight = new Map();
  }

  /**
   * Resolves when a job has finished, however it finished.
   *
   * Callers used to poll for a fixed number of event-loop ticks, which measures
   * nothing useful: on a loaded CI runner 500 ticks elapsed in 19ms while the
   * job was still doing real I/O, and a perfectly healthy job was declared
   * never to have settled. Waiting on the work itself cannot go wrong that way,
   * and needs no number chosen by guesswork.
   */
  async settled(jobId) {
    await this.inFlight.get(jobId);
    return this.get(jobId);
  }

  /**
   * Restores jobs written by a previous process.
   *
   * A job still marked running cannot actually be running: the process that
   * owned it is gone. It is reported as interrupted rather than left to look
   * live forever, because the operator needs to know a destructive action may
   * have stopped halfway.
   */
  async hydrate() {
    if (!this.persist) {
      return;
    }

    let stored = [];

    try {
      stored = await this.readJobs();
    } catch (error) {
      this.logger.warn("job.hydrate_failed", { message: error.message });
      return;
    }

    let interrupted = 0;

    for (const job of stored) {
      if (!job?.id) {
        continue;
      }

      // A handed-off job is expected to survive the restart that interrupted
      // it: that restart is the work. Rewriting it to a failure here would
      // destroy the record that reconciliation needs to finalise.
      if (job.status === JOB_STATUS.HANDED_OFF) {
        this.jobs.set(job.id, job);
        continue;
      }

      if (!TERMINAL_JOB_STATUSES.has(job.status)) {
        interrupted += 1;
        job.status = JOB_STATUS.FAILED;
        job.finishedAt = this.now();
        job.error = {
          message: "Keelarr restarted while this job was running. The service may be part-way through migration — check for a leftover rollback container before retrying.",
          details: { interrupted: true }
        };

        for (const step of job.steps || []) {
          if (step.status === STEP_STATUS.RUNNING) {
            step.status = STEP_STATUS.FAILED;
            step.error = "Interrupted by a controller restart.";
            step.finishedAt = job.finishedAt;
          }
        }
      }

      this.jobs.set(job.id, job);
    }

    this.logger.info("job.hydrated", { restored: this.jobs.size, interrupted });

    if (interrupted > 0) {
      await this.flush();
    }
  }

  schedulePersist() {
    if (!this.persist) {
      return this.writeQueue;
    }

    this.writeQueue = this.writeQueue
      .then(() => this.writeJobs(this.list().map((job) => buildJobSnapshot(job))))
      .catch((error) => {
        // Losing the record must never take down a running job.
        this.logger.warn("job.persist_failed", { message: error.message });
      });

    return this.writeQueue;
  }

  /** Awaits any queued write. Used by hydrate and by tests. */
  flush() {
    return this.schedulePersist();
  }

  /**
   * Steps are declared up front so a caller polling a freshly created job
   * already knows the full plan, including steps that have not started.
   */
  create({ kind, subject = {}, steps = [] }) {
    const runningKey = subjectKey(kind, subject);
    for (const existing of this.jobs.values()) {
      if (!TERMINAL_JOB_STATUSES.has(existing.status) && subjectKey(existing.kind, existing.subject) === runningKey) {
        throw new KeelarrError(`A ${kind} job is already running for this service.`, {
          statusCode: 409,
          details: { jobId: existing.id }
        });
      }
    }

    const job = {
      id: this.createId(),
      kind,
      subject: { ...subject },
      status: JOB_STATUS.PENDING,
      steps: steps.map((step) => (typeof step === "string" ? buildStep(step) : buildStep(step.name, step.label))),
      result: null,
      error: null,
      createdAt: this.now(),
      startedAt: null,
      finishedAt: null
    };

    this.jobs.set(job.id, job);
    this.prune();
    this.schedulePersist();
    return job;
  }

  /**
   * Starts the handler without awaiting it. The caller gets an immediate
   * snapshot so a destructive operation is never tied to an open request.
   */
  start(job, handler) {
    job.status = JOB_STATUS.RUNNING;
    job.startedAt = this.now();
    this.schedulePersist();

    const controller = this.buildController(job);

    const running = Promise.resolve()
      .then(() => handler(controller))
      .then((result) => {
        job.result = result ?? null;
        job.finishedAt = this.now();

        // A handler that catches its own step failures — so that one bad
        // service does not strand the rest — still returns normally, and the
        // job was recording that as success. The steps are the record of what
        // actually happened, so they decide. The result is kept either way:
        // knowing which parts did work is the point of a partial failure.
        const failedSteps = job.steps.filter((step) => step.status === STEP_STATUS.FAILED);

        if (failedSteps.length > 0) {
          job.status = JOB_STATUS.FAILED;
          job.error = {
            message: `${failedSteps.length} of ${job.steps.length} steps failed: ${failedSteps
              .map((step) => step.label || step.name)
              .join(", ")}.`,
            details: { failedSteps: failedSteps.map((step) => step.name) }
          };
          this.schedulePersist();
          this.logger.error("job.failed", {
            jobId: job.id,
            kind: job.kind,
            subject: job.subject,
            message: job.error.message
          });
          return;
        }

        job.status = JOB_STATUS.SUCCEEDED;
        this.schedulePersist();
        this.logger.info("job.succeeded", { jobId: job.id, kind: job.kind, subject: job.subject });
      })
      .catch((error) => {
        job.error = {
          message: error?.message || "Job failed.",
          details: error?.details || null
        };
        job.status = JOB_STATUS.FAILED;
        job.finishedAt = this.now();
        // Mark whatever was mid-flight so a failed job never shows a step
        // stuck in `running` forever.
        for (const step of job.steps) {
          if (step.status === STEP_STATUS.RUNNING) {
            step.status = STEP_STATUS.FAILED;
            step.error = job.error.message;
            step.finishedAt = job.finishedAt;
          }
        }
        this.schedulePersist();
        this.logger.error("job.failed", {
          jobId: job.id,
          kind: job.kind,
          subject: job.subject,
          message: job.error.message
        });
      });

    // The chain above ends in a catch, so this never rejects: awaiting it means
    // "the job has finished", not "the job succeeded".
    this.inFlight.set(job.id, running.finally(() => this.inFlight.delete(job.id)));

    return job;
  }

  buildController(job) {
    const findStep = (name) => {
      const step = job.steps.find((candidate) => candidate.name === name);

      if (!step) {
        throw new KeelarrError(`Job ${job.kind} declared no step named ${name}.`, {
          statusCode: 500
        });
      }

      return step;
    };

    return {
      jobId: job.id,
      /**
       * Runs one declared step, recording status transitions around it.
       * The handler's resolved value is passed straight through; returning
       * `{ detail }` records a human-readable note on the step.
       */
      step: async (name, run) => {
        const step = findStep(name);
        step.status = STEP_STATUS.RUNNING;
        step.startedAt = this.now();
        // Persist before running so a crash mid-step leaves a record pointing
        // at the step that was in flight.
        this.schedulePersist();

        try {
          const outcome = await run();
          step.status = STEP_STATUS.SUCCEEDED;
          step.detail = outcome?.detail ?? null;
          step.finishedAt = this.now();
          this.schedulePersist();
          return outcome;
        } catch (error) {
          step.status = STEP_STATUS.FAILED;
          step.error = error?.message || "Step failed.";
          step.finishedAt = this.now();
          this.schedulePersist();
          throw error;
        }
      },
      skip: (name, reason) => {
        const step = findStep(name);
        step.status = STEP_STATUS.SKIPPED;
        step.detail = reason || null;
        step.finishedAt = this.now();
        this.schedulePersist();
      },
      note: (name, detail) => {
        findStep(name).detail = detail;
        this.schedulePersist();
      }
    };
  }

  get(jobId) {
    const job = this.jobs.get(jobId);

    if (!job) {
      throw new KeelarrError(`Unknown job: ${jobId}`, { statusCode: 404 });
    }

    return job;
  }

  list() {
    return [...this.jobs.values()];
  }

  /** Drops the oldest finished jobs once the registry is over its cap. */
  /**
   * Records that the rest of this job is now somebody else's, and waits.
   *
   * start() marks a job succeeded the moment its handler returns, so a handler
   * that launched the updater and returned would persist a success before the
   * container was even stopped — and hydrate() would then find a terminal job
   * it must not touch. Handing off flushes this state to disk first, then never
   * resolves, so the only thing that can finish this job is reconciliation on
   * the other side of the restart.
   */
  async markHandedOff(job, { operationId, detail = null } = {}) {
    job.status = JOB_STATUS.HANDED_OFF;
    job.handedOffAt = this.now();
    job.subject = { ...(job.subject || {}), operationId };

    if (detail) {
      job.result = { ...(job.result || {}), detail };
    }

    this.schedulePersist();
    // Flushed rather than scheduled: the process may be killed within seconds.
    await this.flush();

    this.logger.info("job.handed_off", { jobId: job.id, kind: job.kind, operationId });

    return new Promise(() => {});
  }

  /**
   * Finishes a handed-off job once the outcome is known.
   *
   * Matched on the operation id rather than the job id alone, so a stale receipt
   * can never close a different attempt, and refused for any job that is not
   * handed off, so it can never rewrite a genuine failure.
   */
  async finalizeHandedOff(operationId, { status, result = null, error = null, steps = {} } = {}) {
    const job = [...this.jobs.values()].find(
      (entry) => entry.status === JOB_STATUS.HANDED_OFF && entry.subject?.operationId === operationId
    );

    if (!job) {
      return null;
    }

    job.status = status;
    job.finishedAt = this.now();
    job.result = result ?? job.result;
    job.error = error;

    for (const [name, patch] of Object.entries(steps)) {
      const step = (job.steps || []).find((entry) => entry.name === name);

      if (step) {
        Object.assign(step, patch, { finishedAt: step.finishedAt || job.finishedAt });
      }
    }

    this.schedulePersist();
    await this.flush();
    this.logger.info("job.finalized", { jobId: job.id, operationId, status });

    return buildJobSnapshot(job);
  }

  prune() {
    if (this.jobs.size <= this.maxJobs) {
      return;
    }

    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= this.maxJobs) {
        break;
      }

      if (TERMINAL_JOB_STATUSES.has(job.status)) {
        this.jobs.delete(id);
      }
    }
  }
}
