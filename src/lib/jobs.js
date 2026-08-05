import { StackarrError } from "./errors.js";
import { defaultLogger } from "./logger.js";

export const JOB_STATUS = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
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
    createId = () => crypto.randomUUID()
  } = {}) {
    this.logger = logger.child({ component: "job-registry" });
    this.maxJobs = maxJobs;
    this.now = now;
    this.createId = createId;
    this.jobs = new Map();
  }

  /**
   * Steps are declared up front so a caller polling a freshly created job
   * already knows the full plan, including steps that have not started.
   */
  create({ kind, subject = {}, steps = [] }) {
    const runningKey = subjectKey(kind, subject);
    for (const existing of this.jobs.values()) {
      if (!TERMINAL_JOB_STATUSES.has(existing.status) && subjectKey(existing.kind, existing.subject) === runningKey) {
        throw new StackarrError(`A ${kind} job is already running for this service.`, {
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
    return job;
  }

  /**
   * Starts the handler without awaiting it. The caller gets an immediate
   * snapshot so a destructive operation is never tied to an open request.
   */
  start(job, handler) {
    job.status = JOB_STATUS.RUNNING;
    job.startedAt = this.now();

    const controller = this.buildController(job);

    Promise.resolve()
      .then(() => handler(controller))
      .then((result) => {
        job.result = result ?? null;
        job.status = JOB_STATUS.SUCCEEDED;
        job.finishedAt = this.now();
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
        this.logger.error("job.failed", {
          jobId: job.id,
          kind: job.kind,
          subject: job.subject,
          message: job.error.message
        });
      });

    return job;
  }

  buildController(job) {
    const findStep = (name) => {
      const step = job.steps.find((candidate) => candidate.name === name);

      if (!step) {
        throw new StackarrError(`Job ${job.kind} declared no step named ${name}.`, {
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

        try {
          const outcome = await run();
          step.status = STEP_STATUS.SUCCEEDED;
          step.detail = outcome?.detail ?? null;
          step.finishedAt = this.now();
          return outcome;
        } catch (error) {
          step.status = STEP_STATUS.FAILED;
          step.error = error?.message || "Step failed.";
          step.finishedAt = this.now();
          throw error;
        }
      },
      skip: (name, reason) => {
        const step = findStep(name);
        step.status = STEP_STATUS.SKIPPED;
        step.detail = reason || null;
        step.finishedAt = this.now();
      },
      note: (name, detail) => {
        findStep(name).detail = detail;
      }
    };
  }

  get(jobId) {
    const job = this.jobs.get(jobId);

    if (!job) {
      throw new StackarrError(`Unknown job: ${jobId}`, { statusCode: 404 });
    }

    return job;
  }

  list() {
    return [...this.jobs.values()];
  }

  /** Drops the oldest finished jobs once the registry is over its cap. */
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
