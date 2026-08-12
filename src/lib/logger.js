import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { logPath } from "./data-paths.js";

/**
 * Where the log gets rolled over, and how many old ones are kept.
 *
 * The log is unbounded otherwise, and it lives in the data directory — which on
 * a NAS is often the small system volume. At `debug` a busy controller writes
 * several megabytes a day, so this caps the whole thing at roughly 15MB rather
 * than letting it grow until something else on the host runs out of room.
 */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP = 2;

const LEVEL_RANK = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const SENSITIVE_KEY_PATTERN = /(pass(word)?|token|secret|api[_-]?key|auth(entication|orization)?|cookie|credential|session|jwt)/i;
const MAX_DEPTH = 5;
const MAX_ARRAY_ITEMS = 25;
const MAX_STRING_LENGTH = 4_000;

export function normalizeLogLevel(level) {
  const normalized = String(level || "").trim().toLowerCase();
  return Object.hasOwn(LEVEL_RANK, normalized) ? normalized : "info";
}

function summarizeError(error) {
  if (!(error instanceof Error)) {
    return error;
  }

  return {
    name: error.name,
    message: error.message,
    stack: typeof error.stack === "string"
      ? error.stack.split("\n").slice(0, 8).join("\n")
      : null
  };
}

function truncateString(value) {
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_STRING_LENGTH)}… [truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}

export function sanitizeForLog(value, depth = 0, seen = new WeakSet()) {
  if (value == null) {
    return value;
  }

  if (typeof value === "string") {
    return truncateString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return sanitizeForLog(summarizeError(value), depth, seen);
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) {
      return `[array(${value.length}) truncated]`;
    }

    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeForLog(item, depth + 1, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[circular]";
    }

    if (depth >= MAX_DEPTH) {
      return "[object truncated]";
    }

    seen.add(value);
    const entries = {};

    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        entries[key] = "[redacted]";
        continue;
      }

      entries[key] = sanitizeForLog(item, depth + 1, seen);
    }

    seen.delete(value);
    return entries;
  }

  return String(value);
}

function toConsoleMethod(consoleImpl, level) {
  if (level === "error") {
    return consoleImpl.error.bind(consoleImpl);
  }

  if (level === "warn") {
    return consoleImpl.warn.bind(consoleImpl);
  }

  if (level === "debug" && typeof consoleImpl.debug === "function") {
    return consoleImpl.debug.bind(consoleImpl);
  }

  return consoleImpl.log.bind(consoleImpl);
}

class LoggerCore {
  constructor({
    name = "stackarr",
    level = process.env.STACKARR_LOG_LEVEL || "info",
    filePath = logPath,
    consoleImpl = console,
    maxBytes = Number(process.env.STACKARR_LOG_MAX_BYTES) || DEFAULT_MAX_BYTES,
    keep = DEFAULT_KEEP
  } = {}) {
    this.name = name;
    this.level = normalizeLogLevel(level);
    this.filePath = filePath;
    this.consoleImpl = consoleImpl;
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.writeQueue = Promise.resolve();
    // Counted rather than stat-ed per line: every write goes through the queue
    // below, so this process is the only one appending. Null means "ask the
    // filesystem once", which covers restarting onto an existing log.
    this.currentBytes = null;
  }

  /**
   * Rolls the log over when it outgrows the cap.
   *
   * Renaming rather than copying, so a reader holding the old file keeps
   * reading it instead of watching lines vanish mid-write. Called only from
   * inside the write queue, which is what makes the counter above safe.
   */
  async rotateIfNeeded(incomingBytes) {
    if (this.maxBytes <= 0) {
      return;
    }

    if (this.currentBytes === null) {
      this.currentBytes = await stat(this.filePath).then((info) => info.size).catch(() => 0);
    }

    if (this.currentBytes + incomingBytes <= this.maxBytes) {
      return;
    }

    // Oldest first, so nothing is overwritten before it has been shifted along.
    for (let index = this.keep; index >= 1; index -= 1) {
      const from = index === 1 ? this.filePath : `${this.filePath}.${index - 1}`;
      const to = `${this.filePath}.${index}`;

      if (index === this.keep) {
        await rm(to, { force: true });
      }

      await rename(from, to).catch(() => {});
    }

    // Re-read rather than assume zero: if a rename failed — a permission
    // problem, a file held open — the old log is still there, and assuming an
    // empty one would let it grow past the cap unnoticed.
    this.currentBytes = await stat(this.filePath).then((info) => info.size).catch(() => 0);
  }

  shouldLog(level) {
    return LEVEL_RANK[normalizeLogLevel(level)] >= LEVEL_RANK[this.level];
  }

  write(level, record) {
    if (!this.shouldLog(level)) {
      return;
    }

    const line = `${JSON.stringify(record)}\n`;
    const print = toConsoleMethod(this.consoleImpl, level);
    print(line.trimEnd());

    const bytes = Buffer.byteLength(line);

    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        await this.rotateIfNeeded(bytes);
        await appendFile(this.filePath, line, "utf8");
        this.currentBytes += bytes;
      })
      .catch((error) => {
        // The count is no longer trustworthy after a failed write; make the
        // next one measure the file instead of guessing.
        this.currentBytes = null;
        const fallback = {
          ts: new Date().toISOString(),
          level: "error",
          logger: this.name,
          event: "logger.write_failed",
          filePath: this.filePath,
          error: error.message
        };
        this.consoleImpl.error(JSON.stringify(fallback));
      });
  }

  flush() {
    return this.writeQueue;
  }
}

export class Logger {
  constructor(core, bindings = {}) {
    this.core = core;
    this.bindings = bindings;
  }

  child(bindings = {}) {
    return new Logger(this.core, {
      ...this.bindings,
      ...sanitizeForLog(bindings)
    });
  }

  log(level, event, context = {}) {
    const normalizedLevel = normalizeLogLevel(level);
    this.core.write(normalizedLevel, {
      ts: new Date().toISOString(),
      level: normalizedLevel,
      logger: this.core.name,
      event,
      ...this.bindings,
      ...sanitizeForLog(context)
    });
  }

  debug(event, context = {}) {
    this.log("debug", event, context);
  }

  info(event, context = {}) {
    this.log("info", event, context);
  }

  warn(event, context = {}) {
    this.log("warn", event, context);
  }

  error(event, context = {}) {
    this.log("error", event, context);
  }

  flush() {
    return this.core.flush();
  }
}

export function createLogger(options = {}) {
  return new Logger(new LoggerCore(options), sanitizeForLog(options.bindings || {}));
}

export const defaultLogger = createLogger();
