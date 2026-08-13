import test from "node:test";
import assert from "node:assert/strict";

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCommand } from "../src/lib/command-runner.js";

test("runCommand returns a failed result when the binary is missing", async () => {
  const result = await runCommand("/definitely-not-keelarr/docker", ["version"]);

  assert.equal(result.ok, false);
  assert.equal(result.code, null);
  assert.match(result.stderr, /ENOENT|not found/i);
});

test("a command that keeps producing output is allowed to outlive the idle window", async () => {
  // The Trailarr case: a pull that was downloading fine, killed at 90s because
  // the deadline was on total duration. Chattering every 60ms under a 250ms
  // idle window, for well past 250ms, must survive.
  const result = await runCommand(
    "sh",
    ["-c", 'i=0; while [ $i -lt 12 ]; do echo "layer $i"; sleep 0.06; i=$((i+1)); done; echo done'],
    { idleTimeoutMs: 250 }
  );

  assert.equal(result.ok, true);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /done/);
});

test("a command that goes silent is reported as stalled, not merely slow", async () => {
  const result = await runCommand(
    "sh",
    ["-c", 'echo "layer 0"; sleep 5; echo "never gets here"'],
    { idleTimeoutMs: 200 }
  );

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.stalled, true);
  // The message has to distinguish the two, or the fix for one looks like the
  // fix for the other.
  assert.match(result.error, /no output for 200ms/);
  assert.doesNotMatch(result.error, /timed out after/);
  // Whatever it managed before stalling is kept, since that is the evidence of
  // how far it got.
  assert.match(result.stdout, /layer 0/);
});

test("progress on stderr counts, because that is where compose reports it", async () => {
  const result = await runCommand(
    "sh",
    ["-c", 'i=0; while [ $i -lt 10 ]; do echo "pulling" >&2; sleep 0.06; i=$((i+1)); done'],
    { idleTimeoutMs: 250 }
  );

  assert.equal(result.ok, true);
  assert.equal(result.stalled, false);
});

test("a total deadline still applies to bounded work", async () => {
  const result = await runCommand("sh", ["-c", "sleep 5"], { timeoutMs: 200 });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.stalled, false);
  assert.match(result.error, /timed out after 200ms/);
});

test("an idle window replaces the total deadline rather than stacking with it", async () => {
  // Both set: the transfer keeps talking for longer than timeoutMs would have
  // allowed, and must not be killed by a bound it was not being judged on.
  const result = await runCommand(
    "sh",
    ["-c", 'i=0; while [ $i -lt 10 ]; do echo tick; sleep 0.06; i=$((i+1)); done'],
    { idleTimeoutMs: 300, timeoutMs: 100 }
  );

  assert.equal(result.ok, true);
  assert.equal(result.timedOut, false);
});

test("a sensitive command's output never reaches the log", async () => {
  // Reading an app's config returns its secrets. At debug level the whole file
  // was being written to data/keelarr.log and to `docker logs` — including
  // SABnzbd's Usenet password in cleartext and Tautulli's Plex token.
  //
  // Shaped like the real call: the secret lives in the file being read, never
  // in the arguments. That is the only safe shape anyway, since argv is visible
  // to any process via `ps`.
  const dir = await mkdtemp(path.join(tmpdir(), "keelarr-sensitive-"));
  const file = path.join(dir, "config.xml");
  await writeFile(file, "password = hunter2\n<ApiKey>deadbeef</ApiKey>\n", "utf8");

  const lines = [];
  const logger = {
    debug: (event, ctx) => lines.push(JSON.stringify({ event, ...ctx })),
    warn: (event, ctx) => lines.push(JSON.stringify({ event, ...ctx }))
  };

  const result = await runCommand("cat", [file], { logger, sensitive: true });

  // The caller still receives the content — that is the point of reading it.
  assert.match(result.stdout, /hunter2/);
  assert.match(result.stdout, /deadbeef/);

  const logged = lines.join("\n");
  assert.equal(logged.includes("hunter2"), false, "the password reached the log");
  assert.equal(logged.includes("deadbeef"), false, "the API key reached the log");
  assert.match(logged, /bytes withheld/);
});

test("an ordinary command still logs its output, so failures stay diagnosable", async () => {
  const lines = [];
  const logger = {
    debug: (event, ctx) => lines.push(JSON.stringify({ event, ...ctx })),
    warn: (event, ctx) => lines.push(JSON.stringify({ event, ...ctx }))
  };

  await runCommand("sh", ["-c", "echo ordinary-output"], { logger });

  assert.match(lines.join("\n"), /ordinary-output/);
});

test("a sensitive command that fails still withholds what it read", async () => {
  const lines = [];
  const logger = {
    debug: (event, ctx) => lines.push(JSON.stringify({ event, ...ctx })),
    warn: (event, ctx) => lines.push(JSON.stringify({ event, ...ctx }))
  };

  // The failure path logs at warn, and was the same leak.
  const missing = path.join(tmpdir(), "keelarr-does-not-exist", "config.xml");
  const result = await runCommand("cat", [missing], { logger, sensitive: true });

  assert.equal(result.ok, false);
  assert.match(lines.join("\n"), /bytes withheld/);
  // The reason it failed is still visible in the exit code.
  assert.match(lines.join("\n"), /"code":[1-9]/);
});
