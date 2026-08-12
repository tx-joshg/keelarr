import test from "node:test";
import assert from "node:assert/strict";

import { findUnmountedRoots, mountedRootsFromEnv, renderControllerEnv, resolveControllerEnvPath } from "../src/lib/host-mounts.js";

const SETTINGS = {
  stackRoot: "/share/Container/docker",
  configRoot: "/share/Container",
  mediaRoot: "/share/Media",
  downloadsRoot: "/share/Media/Downloads",
  plexLogsRoot: "/share/Container/plex/Logs"
};

/** The controller's real mounts on the QNAP: same path on both sides. */
const MOUNTS = [
  { source: "/share/Container/docker", target: "/share/Container/docker" },
  { source: "/share/Container", target: "/share/Container" },
  { source: "/share/Media", target: "/share/Media" },
  { source: "/share/Media/Downloads", target: "/share/Media/Downloads" },
  { source: "/share/Container/plex/Logs", target: "/share/Container/plex/Logs" }
];

test("a fully mounted controller reports nothing", () => {
  assert.deepEqual(findUnmountedRoots(SETTINGS, MOUNTS), []);
});

test("a root the controller cannot see is reported with the variable that fixes it", () => {
  // The failure this exists for: change a root in the UI and only settings.json
  // moves, so the container keeps mounting the old path and every check calls a
  // directory that plainly exists missing.
  const drifted = { ...SETTINGS, mediaRoot: "/share/Public" };
  const found = findUnmountedRoots(drifted, MOUNTS);

  assert.equal(found.length, 1);
  assert.equal(found[0].field, "mediaRoot");
  assert.match(found[0].message, /not mounted into the Stackarr container/);
  assert.match(found[0].message, /HOST_MEDIA_ROOT=\/share\/Public/);
  assert.match(found[0].message, /even though it exists on the host/);
});

test("a root inside a mounted parent counts as covered", () => {
  // /share/Container is mounted, so anything beneath it is visible.
  const nested = { ...SETTINGS, stackRoot: "/share/Container/somewhere/else" };

  assert.deepEqual(findUnmountedRoots(nested, MOUNTS), []);
});

test("a path that merely shares a prefix string is not counted as mounted", () => {
  const lookalike = { ...SETTINGS, mediaRoot: "/share/MediaArchive" };

  assert.equal(findUnmountedRoots(lookalike, MOUNTS).length, 1);
});

test("with no mounts to compare against, nothing is claimed either way", () => {
  // Running outside a container, or the controller's own definition could not
  // be read. Silence beats inventing five warnings.
  assert.deepEqual(findUnmountedRoots(SETTINGS, []), []);
  assert.deepEqual(findUnmountedRoots(SETTINGS, null), []);
});

test("an unset optional root is not reported", () => {
  assert.deepEqual(findUnmountedRoots({ ...SETTINGS, plexLogsRoot: "" }, MOUNTS), []);
});

// --- rendering ---

test("the env file is written from settings, so the two cannot drift", () => {
  const text = renderControllerEnv(SETTINGS);

  assert.match(text, /HOST_MEDIA_ROOT=\/share\/Media$/m);
  assert.match(text, /HOST_STACK_ROOT=\/share\/Container\/docker$/m);
  assert.match(text, /HOST_PLEX_LOGS_ROOT=\/share\/Container\/plex\/Logs$/m);
});

test("values Stackarr does not own are preserved, not reset to defaults", () => {
  // The data directory is where settings themselves live, so it cannot be
  // derived from them; port and log level are deployment choices.
  const existing = "STACKARR_PORT=9999\nSTACKARR_LOG_LEVEL=debug\nSTACKARR_DATA_DIR=/share/Container/stackarr/data\n";
  const text = renderControllerEnv(SETTINGS, existing);

  assert.match(text, /STACKARR_PORT=9999/);
  assert.match(text, /STACKARR_LOG_LEVEL=debug/);
  assert.match(text, /STACKARR_DATA_DIR=\/share\/Container\/stackarr\/data/);
});

test("a first write falls back to defaults for the values it cannot know", () => {
  const text = renderControllerEnv(SETTINGS, "");

  assert.match(text, /STACKARR_PORT=4687/);
  assert.match(text, /STACKARR_LOG_LEVEL=info/);
});

test("the file says who wrote it and what to do next", () => {
  const text = renderControllerEnv(SETTINGS);

  assert.match(text, /Written by Stackarr/);
  assert.match(text, /Recreate the controller/);
});

// --- locating the file from inside the container ---

test("the recorded deploy directory is used when it is reachable", async () => {
  const found = await resolveControllerEnvPath(
    { workingDir: "/opt/stackarr/deploy", composeFile: "/opt/stackarr/deploy/compose.example.yml", mounts: [] },
    { pathExistsImpl: async (p) => p === "/opt/stackarr/deploy/compose.example.yml" }
  );

  assert.equal(found, "/opt/stackarr/deploy/.env");
});

test("a deploy directory reachable only by another path is still found", async () => {
  // QNAP records /share/CACHEDEV1_DATA/Container/... while what is mounted is
  // /share/Container/... — the same directory, reached a different way.
  const found = await resolveControllerEnvPath(
    {
      workingDir: "/share/CACHEDEV1_DATA/Container/stackarr/deploy",
      composeFile: "/share/CACHEDEV1_DATA/Container/stackarr/deploy/compose.example.yml",
      mounts: [{ source: "/share/Container", target: "/share/Container" }]
    },
    { pathExistsImpl: async (p) => p === "/share/Container/stackarr/deploy/compose.example.yml" }
  );

  assert.equal(found, "/share/Container/stackarr/deploy/.env");
});

test("a candidate without the compose file in it is not accepted", async () => {
  // Guards against matching a lookalike directory by path shape alone.
  const found = await resolveControllerEnvPath(
    {
      workingDir: "/opt/stackarr/deploy",
      composeFile: "/opt/stackarr/deploy/compose.example.yml",
      mounts: [{ source: "/share/Container", target: "/share/Container" }]
    },
    { pathExistsImpl: async () => false }
  );

  assert.equal(found, null);
});

test("a controller with no compose labels resolves to nothing rather than guessing", async () => {
  assert.equal(await resolveControllerEnvPath({ workingDir: null, mounts: [] }), null);
});

test("the mounted deploy directory is used before anything is deduced", async () => {
  // A relative bind in the Compose file resolves against that file's own
  // directory, so this path is known rather than worked out from labels.
  const found = await resolveControllerEnvPath(
    { workingDir: "/somewhere/else", composeFile: "/somewhere/else/compose.yml", mounts: [] },
    { pathExistsImpl: async (p) => p === "/app/deploy-host/.env" }
  );

  assert.equal(found, "/app/deploy-host/.env");
});

test("without that mount it still falls back to deducing the path", async () => {
  // Controllers deployed before the mount existed must keep working.
  const found = await resolveControllerEnvPath(
    { workingDir: "/opt/stackarr/deploy", composeFile: "/opt/stackarr/deploy/compose.example.yml", mounts: [] },
    { pathExistsImpl: async (p) => p === "/opt/stackarr/deploy/compose.example.yml" }
  );

  assert.equal(found, "/opt/stackarr/deploy/.env");
});

test("a fresh clone with no .env yet still resolves to the mounted deploy directory", async () => {
  // The case that matters most and used to fail: on a first install there is no
  // .env at all — writing the first one is the whole point — so requiring the
  // file to exist meant it was never created. The compose file identifies the
  // directory instead.
  const found = await resolveControllerEnvPath(
    { workingDir: "/private/tmp/checkout/deploy", composeFile: "/private/tmp/checkout/deploy/compose.example.yml", mounts: [] },
    { pathExistsImpl: async (p) => p === "/app/deploy-host/compose.example.yml" }
  );

  assert.equal(found, "/app/deploy-host/.env");
});

test("an empty deploy mount is not mistaken for the deploy directory", async () => {
  // Neither marker present, so nothing there identifies it and the fallback
  // deduction has to be what answers.
  const found = await resolveControllerEnvPath(
    { workingDir: "/opt/stackarr/deploy", composeFile: "/opt/stackarr/deploy/compose.example.yml", mounts: [] },
    { pathExistsImpl: async (p) => p === "/opt/stackarr/deploy/compose.example.yml" }
  );

  assert.equal(found, "/opt/stackarr/deploy/.env");
});

test("a renamed compose file still identifies the mounted deploy directory", async () => {
  const found = await resolveControllerEnvPath(
    { workingDir: "/somewhere/else", composeFile: "/somewhere/else/docker-compose.yml", mounts: [] },
    { pathExistsImpl: async (p) => p === "/app/deploy-host/docker-compose.yml" }
  );

  assert.equal(found, "/app/deploy-host/.env");
});

test("the roots Compose mounted are read back from the environment", () => {
  const roots = mountedRootsFromEnv({
    HOST_STACK_ROOT: "/Users/someone/stackarr/stacks",
    HOST_MEDIA_ROOT: "/Users/someone/stackarr/media",
    HOST_PLEX_LOGS_ROOT: "   ",
    UNRELATED: "/nope"
  });

  assert.deepEqual(roots, {
    stackRoot: "/Users/someone/stackarr/stacks",
    mediaRoot: "/Users/someone/stackarr/media"
  });
});

test("a controller deployed before those variables existed reports none", () => {
  // The NAS is exactly this case, so absent must mean "fall back", not "empty
  // string" — an empty root would read as a deliberate blank.
  assert.deepEqual(mountedRootsFromEnv({}), {});
});
