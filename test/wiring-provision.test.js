import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";

import { ensureLibraryFolder } from "../src/lib/wiring/provision.js";

/**
 * The mount that makes this interesting: the app sees /Media, the controller
 * sees a different path entirely. Checking or creating the container path on
 * the controller's filesystem tests a directory that can never exist there.
 */
function mounts(mediaHostPath) {
  return [
    { source: "/var/lib/docker/volumes/abc/_data", target: "/config" },
    { source: mediaHostPath, target: "/Media" }
  ];
}

async function media(t) {
  const root = await mkdtemp(path.join(tmpdir(), "stackarr-provision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o775);
  return root;
}

test("the folder is created on the host path behind the container path", async (t) => {
  const root = await media(t);
  const result = await ensureLibraryFolder(mounts(root), "/Media/Music");

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.hostPath, path.join(root, "Music"));
  assert.ok((await stat(result.hostPath)).isDirectory());
});

test("it copies the parent's permissions rather than trusting the umask", async (t) => {
  const root = await media(t);
  await chmod(root, 0o777);

  const result = await ensureLibraryFolder(mounts(root), "/Media/Music");
  const created = await stat(result.hostPath);

  // These shares are frequently world-writable on purpose. An app that cannot
  // write to its own library folder fails in ways that are tedious to diagnose.
  assert.equal(created.mode & 0o777, 0o777);
});

test("an existing folder is left exactly as it is", async (t) => {
  const root = await media(t);
  const existing = path.join(root, "Music");
  await mkdir(existing);
  await chmod(existing, 0o700);

  const result = await ensureLibraryFolder(mounts(root), "/Media/Music");

  assert.equal(result.created, false);
  assert.equal((await stat(existing)).mode & 0o777, 0o700, "an existing library must not be re-permissioned");
});

test("a path outside any mount is refused rather than created somewhere wrong", async (t) => {
  const root = await media(t);
  const result = await ensureLibraryFolder(mounts(root), "/somewhere/else/Music");

  assert.equal(result.ok, false);
  assert.match(result.reason, /not backed by a host directory/);
});

test("an unmounted volume is refused rather than written into", async (t) => {
  const root = await media(t);
  const result = await ensureLibraryFolder(mounts(path.join(root, "absent")), "/Media/Music");

  // Creating inside an empty mount point leaves a directory that disappears
  // behind the real storage the moment it mounts, which looks like data loss.
  assert.equal(result.ok, false);
  assert.match(result.reason, /may not be mounted/);
});

test("nested library paths are created in full", async (t) => {
  const root = await media(t);
  const result = await ensureLibraryFolder(mounts(root), "/Media/Library/Music");

  assert.equal(result.ok, true);
  assert.ok((await stat(path.join(root, "Library", "Music"))).isDirectory());
});
