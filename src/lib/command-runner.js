import { spawn } from "node:child_process";

export const DEFAULT_TIMEOUT_MS = 90_000;

export function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    options.logger?.debug("command.start", {
      command,
      args,
      cwd: options.cwd || null,
      timeoutMs
    });

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) }
    });

    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    function finalize(result) {
      options.logger?.[result.ok ? "debug" : "warn"]("command.finish", {
        command,
        args,
        cwd: options.cwd || null,
        timeoutMs,
        code: result.code,
        ok: result.ok,
        timedOut,
        error: result.error,
        stdout: result.stdout,
        stderr: result.stderr
      });
      resolve(result);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
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
        timedOut
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
        error: timedOut ? `Command timed out after ${timeoutMs}ms.` : null,
        timedOut
      });
    });
  });
}
