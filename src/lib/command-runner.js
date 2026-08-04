import { spawn } from "node:child_process";

export const DEFAULT_TIMEOUT_MS = 90_000;

export function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) }
    });

    let settled = false;
    let stdout = "";
    let stderr = "";
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);

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
      resolve({
        code: null,
        stdout,
        stderr: stderr || error.message,
        ok: false,
        error: error.message
      });
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        ok: code === 0,
        error: code === 0 ? null : null
      });
    });
  });
}
