import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

const KEY_LENGTH = 64;
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Deliberately not a configurable minimum. Stackarr holds the Docker socket, so
 * anyone reaching it can run containers on this host; a four-character password
 * is not a meaningful gate over that.
 */
export const MIN_PASSWORD_LENGTH = 8;

export const SESSION_COOKIE = "stackarr_session";

export async function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const derived = await scryptAsync(String(password), salt, KEY_LENGTH);
  return { salt, hash: derived.toString("hex") };
}

/**
 * Compared in constant time. A plain string comparison leaks how much of the
 * hash matched through timing, which is enough to recover it byte by byte.
 */
export async function verifyPassword(password, record) {
  if (!record?.salt || !record?.hash) {
    return false;
  }

  const candidate = await scryptAsync(String(password), record.salt, KEY_LENGTH);
  const expected = Buffer.from(record.hash, "hex");

  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/**
 * A signed token rather than a server-side session table.
 *
 * Restarting the controller happens often — every upgrade recreates it — and
 * an in-memory session store would sign the operator out each time for no
 * security benefit. The signature is over the issue time, so a token cannot be
 * extended by editing it.
 */
export function createSessionToken(secret, issuedAt = Date.now()) {
  const payload = String(issuedAt);
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(token, secret, { maxAgeMs = SESSION_MAX_AGE_MS, now = Date.now() } = {}) {
  const [payload, signature] = String(token || "").split(".");

  if (!payload || !signature) {
    return false;
  }

  const expected = sign(payload, secret);

  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return false;
  }

  const issuedAt = Number(payload);
  return Number.isFinite(issuedAt) && now - issuedAt < maxAgeMs && issuedAt <= now;
}

function sign(payload, secret) {
  return createHmac("sha256", String(secret)).update(payload).digest("hex");
}

/** Parses a Cookie header without pulling in a dependency to do it. */
export function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");

    if (index === -1) {
      continue;
    }

    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }

  return null;
}

export function buildSessionCookie(token, { secure = false, maxAgeMs = SESSION_MAX_AGE_MS } = {}) {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    // Lax rather than Strict: a bookmark or a link from another app should
    // still land you signed in, and there are no cross-site state changes here
    // that SameSite=Strict would be protecting against.
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    ...(secure ? ["Secure"] : [])
  ].join("; ");
}

export function buildLogoutCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
