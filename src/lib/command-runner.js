import { spawn } from "node:child_process";

export const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * How long a long-running command may produce nothing before it is considered
 * stuck.
 *
 * Pulling an image has no honest total deadline — it depends on the image, the
 * connection and the day — and guessing one killed a Trailarr pull that was
 * downloading perfectly well. What can be judged is whether it is still making
 * progress: `docker compose pull` reports every layer as it goes, so silence
 * this long means stalled, not slow.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

export function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    // A total deadline and a silence deadline answer different questions, so a
    // command uses one or the other rather than both: bounded work gets
    // `timeoutMs`, open-ended transfers get `idleTimeoutMs`.
    const idleTimeoutMs = options.idleTimeoutMs || null;
    const timeoutMs = idleTimeoutMs ? null : options.timeoutMs || DEFAULT_TIMEOUT_MS;

    options.logger?.debug("command.start", {
      command,
      args,
      cwd: options.cwd || null,
      timeoutMs,
      idleTimeoutMs
    });

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) }
    });

    let settled = false;
    let timedOut = false;
    let stalled = false;
    let stdout = "";
    let stderr = "";
    let timer = null;

    function armTimer() {
      if (timeoutMs) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, timeoutMs);
        return;
      }

      timer = setTimeout(() => {
        timedOut = true;
        stalled = true;
        child.kill("SIGTERM");
      }, idleTimeoutMs);
    }

    /** Only an idle deadline moves; a total one is fixed by definition. */
    function sawProgress() {
      if (!idleTimeoutMs || settled) {
        return;
      }

      clearTimeout(timer);
      armTimer();
    }

    armTimer();

    function describeTimeout() {
      if (!timedOut) {
        return null;
      }

      return stalled
        ? `Command produced no output for ${idleTimeoutMs}ms and appears to have stalled.`
        : `Command timed out after ${timeoutMs}ms.`;
    }

    function finalize(result) {
      options.logger?.[result.ok ? "debug" : "warn"]("command.finish", {
        command,
        args,
        cwd: options.cwd || null,
        timeoutMs,
        idleTimeoutMs,
        code: result.code,
        ok: result.ok,
        timedOut,
        stalled,
        error: result.error,
        stdout: result.stdout,
        stderr: result.stderr
      });
      resolve(result);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      sawProgress();
    });

    child.stderr.on("data", (chunk) => {
      // Compose reports transfer progress on stderr, so this is the stream that
      // usually proves a pull is alive.
      stderr += chunk.toString();
      sawProgress();
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      finalize({
        code: null,
        stdout,
        stderr: stderr || error.message,
        ok: false,
        error: error.message,
        timedOut,
        stalled
      });
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      finalize({
        code,
        stdout,
        stderr,
        ok: code === 0,
        error: describeTimeout(),
        timedOut,
        stalled
      });
    });
  });
}
