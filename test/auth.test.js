import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHttpApp } from "../src/create-http-app.js";
import { DemoKeelarrAppService } from "../src/lib/demo-service.js";
import {
  MIN_PASSWORD_LENGTH,
  SESSION_COOKIE,
  buildSessionCookie,
  createSessionToken,
  hashPassword,
  readCookie,
  verifyPassword,
  verifySessionToken
} from "../src/lib/auth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");

const silentLogger = {
  child: () => silentLogger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
};

/** Stands in for auth.json, so no test writes to the real data directory. */
function createAuthStore(initial = null) {
  let record = initial;

  return {
    read: async () => record,
    write: async (next) => {
      record = next;
    },
    current: () => record
  };
}

async function withServer(options, run) {
  const store = options.store || createAuthStore(options.initial ?? null);
  const app = createHttpApp({
    publicDir,
    keelarrApp: options.keelarrApp || new DemoKeelarrAppService(),
    logger: silentLogger,
    readAuthImpl: store.read,
    writeAuthImpl: store.write,
    ...(options.requireAuth === undefined ? {} : { requireAuth: options.requireAuth })
  });
  const server = await new Promise((resolve) => {
    const handle = app.listen(0, "127.0.0.1", () => resolve(handle));
  });

  try {
    return await run(`http://127.0.0.1:${server.address().port}`, store);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("a password verifies only against itself", async () => {
  const record = await hashPassword("correct horse battery");

  assert.equal(await verifyPassword("correct horse battery", record), true);
  assert.equal(await verifyPassword("correct horse batter", record), false);
  assert.equal(await verifyPassword("", record), false);
  // A missing record must not read as a match, or a controller with no password
  // set would accept every password rather than none.
  assert.equal(await verifyPassword("anything", null), false);
  assert.equal(await verifyPassword("anything", { salt: "abc" }), false);
});

test("the stored record never contains the password itself", async () => {
  const record = await hashPassword("hunter2hunter2");

  assert.equal(JSON.stringify(record).includes("hunter2"), false);
  assert.equal(typeof record.salt, "string");
  assert.equal(record.hash.length, 128);
});

test("the same password hashes differently for two installs", async () => {
  const first = await hashPassword("shared password");
  const second = await hashPassword("shared password");

  // Distinct salts, so one leaked hash says nothing about another install.
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
});

test("a session token is rejected once edited, re-signed elsewhere, or aged out", () => {
  const secret = "a-secret";
  const issuedAt = 1_700_000_000_000;
  const token = createSessionToken(secret, issuedAt);

  assert.equal(verifySessionToken(token, secret, { now: issuedAt + 1000 }), true);

  // Extending the issue time invalidates the signature, so a token cannot buy
  // itself more time.
  const [, signature] = token.split(".");
  assert.equal(verifySessionToken(`${issuedAt + 999_999}.${signature}`, secret, { now: issuedAt }), false);

  // Another controller's secret does not open this one.
  assert.equal(verifySessionToken(createSessionToken("other-secret", issuedAt), secret, { now: issuedAt }), false);

  assert.equal(verifySessionToken(token, secret, { now: issuedAt + 31 * 24 * 60 * 60 * 1000 }), false);
  assert.equal(verifySessionToken("", secret), false);
  assert.equal(verifySessionToken("nonsense", secret), false);
});

test("cookies are parsed by name, not by substring", () => {
  const header = `other=1; ${SESSION_COOKIE}=abc.def; not_${SESSION_COOKIE}=wrong`;

  assert.equal(readCookie(header, SESSION_COOKIE), "abc.def");
  assert.equal(readCookie(header, "missing"), null);
  assert.equal(readCookie(undefined, SESSION_COOKIE), null);
});

test("the session cookie is not readable by scripts", () => {
  const cookie = buildSessionCookie("token-value");

  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
});

test("an unauthenticated caller cannot reach the API", async () => {
  await withServer({ initial: null }, async (base) => {
    const response = await fetch(`${base}/api/state`);
    const data = await response.json();

    assert.equal(response.status, 401);
    // The page uses this to tell a first run apart from a lapsed session.
    assert.equal(data.details.configured, false);
  });
});

test("the healthcheck answers without a password", async () => {
  await withServer({ initial: null }, async (base) => {
    const response = await fetch(`${base}/api/health`);

    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  });
});

test("first run sets a password and signs the operator straight in", async () => {
  await withServer({ initial: null }, async (base, store) => {
    const response = await fetch(`${base}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "a-good-password" })
    });
    const cookie = response.headers.get("set-cookie");

    assert.equal(response.status, 200);
    assert.equal(typeof cookie, "string");

    const state = await fetch(`${base}/api/state`, { headers: { cookie } });
    assert.equal(state.status, 200);

    // What lands on disk is a hash and a signing secret, never the password.
    assert.equal(JSON.stringify(store.current()).includes("a-good-password"), false);
  });
});

test("setup refuses a short password", async () => {
  await withServer({ initial: null }, async (base, store) => {
    const response = await fetch(`${base}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "short" })
    });

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, new RegExp(String(MIN_PASSWORD_LENGTH)));
    assert.equal(store.current(), null);
  });
});

test("setup cannot replace a password that already exists", async () => {
  const existing = { ...(await hashPassword("original-password")), secret: "secret" };

  await withServer({ initial: existing }, async (base, store) => {
    const response = await fetch(`${base}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "attacker-password" })
    });

    assert.equal(response.status, 409);
    assert.equal(store.current().hash, existing.hash);
  });
});

test("login rejects the wrong password and accepts the right one", async () => {
  const existing = { ...(await hashPassword("original-password")), secret: "signing-secret" };

  await withServer({ initial: existing }, async (base) => {
    const wrong = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "guess" })
    });

    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get("set-cookie"), null);

    const right = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "original-password" })
    });
    const cookie = right.headers.get("set-cookie");

    assert.equal(right.status, 200);

    const state = await fetch(`${base}/api/state`, { headers: { cookie } });
    assert.equal(state.status, 200);
  });
});

test("a forged cookie does not open the API", async () => {
  const existing = { ...(await hashPassword("original-password")), secret: "signing-secret" };

  await withServer({ initial: existing }, async (base) => {
    const forged = createSessionToken("a-different-secret");
    const response = await fetch(`${base}/api/state`, {
      headers: { cookie: `${SESSION_COOKIE}=${forged}` }
    });

    assert.equal(response.status, 401);
    assert.equal((await response.json()).details.configured, true);
  });
});

test("signing out ends the session for the browser", async () => {
  const existing = { ...(await hashPassword("original-password")), secret: "signing-secret" };

  await withServer({ initial: existing }, async (base) => {
    const response = await fetch(`${base}/api/auth/logout`, { method: "POST" });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  });
});

test("status reports which screen to show without leaking anything", async () => {
  const existing = { ...(await hashPassword("original-password")), secret: "signing-secret" };

  await withServer({ initial: null }, async (base) => {
    const fresh = await (await fetch(`${base}/api/auth/status`)).json();

    assert.equal(fresh.required, true);
    assert.equal(fresh.configured, false);
    assert.equal(fresh.authenticated, false);
    assert.equal(fresh.minPasswordLength, MIN_PASSWORD_LENGTH);
  });

  await withServer({ initial: existing }, async (base) => {
    const body = await (await fetch(`${base}/api/auth/status`)).text();

    assert.equal(body.includes(existing.hash), false);
    assert.equal(body.includes(existing.salt), false);
    assert.equal(body.includes(existing.secret), false);
    assert.equal(JSON.parse(body).configured, true);
    assert.equal(JSON.parse(body).authenticated, false);

    const signedIn = await (await fetch(`${base}/api/auth/status`, {
      headers: { cookie: `${SESSION_COOKIE}=${createSessionToken(existing.secret)}` }
    })).json();

    assert.equal(signedIn.authenticated, true);
  });
});

test("the demo runs without a password, since it has no Docker socket behind it", async () => {
  await withServer({ initial: null, requireAuth: false }, async (base) => {
    const state = await fetch(`${base}/api/state`);
    const status = await (await fetch(`${base}/api/auth/status`)).json();

    assert.equal(state.status, 200);
    assert.equal(status.required, false);
    assert.equal(status.authenticated, true);
  });
});
