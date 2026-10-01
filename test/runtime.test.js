import test from "node:test";
import assert from "node:assert/strict";

import {
  buildConfigRestoreScript,
  buildRollbackRecord,
  explainDeployFailure,
  deriveUpdateStatusFromPullResult,
  normalizeComposePsData,
  normalizeImageId
} from "../src/lib/runtime.js";

test("normalizeComposePsData preserves array payloads", () => {
  const payload = [{ Name: "trailarr", State: "running" }];

  assert.deepEqual(normalizeComposePsData(payload), payload);
});

test("normalizeComposePsData wraps single-object payloads from one-service compose projects", () => {
  const payload = { Name: "trailarr", State: "running" };

  assert.deepEqual(normalizeComposePsData(payload), [payload]);
});

test("normalizeComposePsData falls back to an empty list for nullish payloads", () => {
  assert.deepEqual(normalizeComposePsData(null), []);
  assert.deepEqual(normalizeComposePsData(undefined), []);
});

test("normalizeImageId trims whitespace and returns null for empty values", () => {
  assert.equal(normalizeImageId(" sha256:abc123 \n"), "sha256:abc123");
  assert.equal(normalizeImageId(""), null);
});

test("deriveUpdateStatusFromPullResult marks a pulled image as current when the running image id matches", () => {
  const status = deriveUpdateStatusFromPullResult("trailarr Pulling\ntrailarr Pulled", "sha256:same", "sha256:same");

  assert.equal(status, "current");
});

test("deriveUpdateStatusFromPullResult marks a pulled image as ready when the running image id differs", () => {
  const status = deriveUpdateStatusFromPullResult("trailarr Pulling\ntrailarr Pulled", "sha256:old", "sha256:new");

  assert.equal(status, "ready");
});

test("buildRollbackRecord pins the running image id rather than the mutable tag", () => {
  const record = buildRollbackRecord({
    id: "trailarr",
    containerName: "trailarr",
    image: "nandyalu/trailarr:latest"
  }, {
    imageId: "sha256:old",
    imageRepoDigest: "nandyalu/trailarr@sha256:olddigest",
    backedUpAt: "2026-08-05T00:00:00.000Z"
  });

  assert.deepEqual(record, {
    serviceId: "trailarr",
    containerName: "trailarr",
    image: "nandyalu/trailarr:latest",
    imageId: "sha256:old",
    imageRepoDigest: "nandyalu/trailarr@sha256:olddigest",
    configSnapshot: null,
    backedUpAt: "2026-08-05T00:00:00.000Z"
  });
});

test("buildRollbackRecord degrades to nulls when the image identity cannot be read", () => {
  const record = buildRollbackRecord({
    id: "ombi",
    containerName: "ombi"
  }, {
    imageId: null,
    imageRepoDigest: null,
    backedUpAt: "2026-08-05T00:00:00.000Z"
  });

  assert.equal(record.image, null);
  assert.equal(record.imageId, null);
  assert.equal(record.imageRepoDigest, null);
});

test("buildRollbackRecord carries the config snapshot when one was captured", () => {
  const record = buildRollbackRecord({ id: "radarr", containerName: "radarr", image: "linuxserver/radarr:latest" }, {
    imageId: "sha256:old",
    imageRepoDigest: "linuxserver/radarr@sha256:old",
    backedUpAt: "2026-08-05T00:00:00.000Z",
    configSnapshot: { file: "config-snapshot.tar.gz", mountType: "volume", mountSource: "radarr_config" }
  });

  assert.equal(record.configSnapshot.file, "config-snapshot.tar.gz");
  assert.equal(record.configSnapshot.mountType, "volume");
});

test("explainDeployFailure translates Docker's opaque pull errors", () => {
  assert.match(
    explainDeployFailure("Image lscr.io/linuxserver/readarr:develop Pulling\nno matching manifest for linux/amd64 in the manifest list entries"),
    /no build for linux\/amd64/
  );
  assert.match(explainDeployFailure("manifest unknown"), /tag does not exist/);
  assert.match(explainDeployFailure("Bind for 0.0.0.0:8787 failed: port is already allocated"), /already in use/);
  assert.match(explainDeployFailure("pull access denied"), /refused the pull/);
  assert.equal(explainDeployFailure("something else entirely"), null);
  assert.equal(explainDeployFailure(""), null);
});

test("config snapshot exclusions match either casing apps use", async () => {
  const { CONFIG_SNAPSHOT_EXCLUDES } = await import("../src/lib/runtime.js");
  const patterns = CONFIG_SNAPSHOT_EXCLUDES.join(" ");

  // Trailarr writes `backups` and `logs`; the Arr apps write `Backups` and
  // `MediaCover`. A single fixed spelling missed half of them, which is how a
  // 13M database produced a 513M snapshot.
  assert.match(patterns, /\[Bb\]ackups/);
  assert.match(patterns, /\[Ll\]ogs/);
  assert.match(patterns, /\[Mm\]edia\[Cc\]over/);
  assert.match(patterns, /\[Cc\]ache/);
  // Shipped frontend assets, not configuration.
  assert.match(patterns, /\.\/web/);
});

test("a port conflict names the port, because a busy host has many", () => {
  const dockerSays = "Error response from daemon: failed to set up container networking: "
    + "driver failed programming external connectivity on endpoint sabnzbd (12c6): "
    + "Bind for 0.0.0.0:8080 failed: port is already allocated";

  const explained = explainDeployFailure(dockerSays);

  assert.match(explained, /8080/);
  assert.match(explained, /already in use/);
  // Actionable, not just descriptive.
  assert.match(explained, /Change this app's port|stop whatever holds/);
});

test("the older bind message is recognised too", () => {
  assert.match(explainDeployFailure("listen tcp 0.0.0.0:9696: bind: address already in use"), /9696/);
});

test("a conflict with no port in the message still explains itself", () => {
  const explained = explainDeployFailure("port is already allocated");

  assert.match(explained, /already in use/);
  assert.doesNotMatch(explained, /undefined/);
});

test("restoring a config snapshot keeps what the snapshot deliberately excluded", () => {
  const script = buildConfigRestoreScript();

  // Clearing all of /config would delete the app's own database backups to
  // restore an archive that never contained them — removing the recovery copies
  // an operator needs precisely when a rollback did not work either. Trailarr's
  // config/backups is what made the 25 September failure diagnosable at all.
  assert.match(script, /case "\$entry" in/);
  assert.match(script, /\[Bb\]ackups/);
  assert.match(script, /\[Ll\]ogs/);
  assert.ok(!/rm -rf \/dst\/\*/.test(script), "no blanket wipe of the config directory");
  // Still destructive for everything the snapshot does cover: a file written
  // after it must not survive and confuse the older version.
  assert.match(script, /rm -rf "\$entry"/);
  assert.match(script, /tar xzf \/backup\/config-snapshot\.tar\.gz -C \/dst/);
});

test("the restore script survives a config directory with no dotfiles", () => {
  // `.[!.]*` comes through literally when nothing matches, and `rm -rf` on that
  // literal would fail under `set -e`.
  assert.match(buildConfigRestoreScript(), /\[ -e "\$entry" \] \|\| continue/);
});

test("the restore validates the archive before it deletes anything", () => {
  const script = buildConfigRestoreScript();

  // A missing or truncated snapshot discovered by `tar xzf` after the live
  // config was cleared turns an ordinary failed upgrade into a fresh install.
  // Under `set -e` the listing pass fails first and nothing is removed.
  const listAt = script.indexOf("tar tzf");
  const clearAt = script.indexOf("rm -rf");

  assert.ok(listAt !== -1, "the archive is read through first");
  assert.ok(listAt < clearAt, "and that happens before the clearing loop");
});

test("the selective clear reaches names beginning with two dots", () => {
  // `.[!.]*` matches `.env` but not `..state`, so a file like that would have
  // survived a restore that promised to discard post-snapshot state.
  assert.match(buildConfigRestoreScript(), /for entry in \* \.\[!\.\]\* \.\?\?\*; do/);
});

test("the restore honours the exclusions recorded with the snapshot", () => {
  const script = buildConfigRestoreScript(["./[Bb]ackups"]);

  assert.match(script, /\[Bb\]ackups\) continue/);
  assert.ok(!/\[Mm\]edia\[Cc\]over/.test(script), "today's list does not leak into an older snapshot's restore");
  // An empty or missing record falls back rather than clearing everything.
  assert.match(buildConfigRestoreScript([]), /\[Bb\]ackups/);
  assert.match(buildConfigRestoreScript(undefined), /\[Bb\]ackups/);
});
