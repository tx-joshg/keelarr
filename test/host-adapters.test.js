import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { applyDetectionSuggestions, pickBestHostDetection, pickHostDetection } from "../src/lib/host-adapters/index.js";
import { resolveGenericDockerSuggestedPaths, validateGenericDockerHost } from "../src/lib/host-adapters/generic-docker.js";
import { identityCanWriteInto } from "../src/lib/host-adapters/shared.js";

test("selects the highest-scoring host detection", () => {
  const selected = pickBestHostDetection([
    { adapterId: "generic-docker", score: 60 },
    { adapterId: "qnap", score: 90 }
  ]);

  assert.equal(selected.adapterId, "qnap");
});

test("uses the preferred host detection when one is supplied", () => {
  const selected = pickHostDetection([
    { adapterId: "generic-docker", score: 85 },
    { adapterId: "qnap", score: 70 }
  ], "qnap");

  assert.equal(selected.adapterId, "qnap");
});

test("applies detection suggestions over draft settings", () => {
  const next = applyDetectionSuggestions(
    {
      dockerBin: "docker",
      stackRoot: "/opt/keelarr/stacks"
    },
    {
      suggestedSettings: {
        dockerBin: "/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker",
        stackRoot: "/share/Container/docker"
      }
    }
  );

  assert.equal(next.dockerBin, "/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker");
  assert.equal(next.stackRoot, "/share/Container/docker");
});

test("resets generic host defaults when explicitly switching away from a QNAP profile", () => {
  const suggested = resolveGenericDockerSuggestedPaths({
    adapterType: "qnap",
    stackRoot: "/share/Container/docker",
    configRoot: "/share/Container",
    mediaRoot: "/share/Media",
    downloadsRoot: "/share/Media/Downloads",
    plexLogsRoot: "/share/Container/plex/Logs"
  }, {
    preferredAdapterId: "generic-docker"
  });

  assert.deepEqual(suggested, {
    stackRoot: "/opt/keelarr/stacks",
    configRoot: "/srv/keelarr/config",
    mediaRoot: "/srv/media",
    downloadsRoot: "/srv/media/downloads",
    plexLogsRoot: ""
  });
});

test("host validation fails when the saved Docker binary is invalid", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "keelarr-host-validation-"));
  const stackRoot = path.join(root, "stacks");
  const configRoot = path.join(root, "config");
  const mediaRoot = path.join(root, "media");
  const downloadsRoot = path.join(mediaRoot, "downloads");

  await mkdir(stackRoot, { recursive: true });
  await mkdir(configRoot, { recursive: true });
  await mkdir(downloadsRoot, { recursive: true });

  const result = await validateGenericDockerHost({
    dockerBin: "/definitely-not-keelarr/docker",
    stackRoot,
    configRoot,
    mediaRoot,
    downloadsRoot,
    plexLogsRoot: "",
    selectedServiceIds: ["trailarr"]
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /Docker binary could not be executed/i);
});

test("detection suggests the roots this controller was actually mounted with", async () => {
  // Otherwise a fresh desktop install is told to use /opt and /srv — paths the
  // Compose file does not mount and Docker Desktop will not mount, so the very
  // first save reports four roots as unreachable.
  const paths = resolveGenericDockerSuggestedPaths({}, {
    preferredAdapterId: "generic-docker",
    mountedRoots: {
      stackRoot: "/Users/someone/keelarr/stacks",
      configRoot: "/Users/someone/keelarr/config",
      mediaRoot: "/Users/someone/keelarr/media",
      downloadsRoot: "/Users/someone/keelarr/media/downloads"
    }
  });

  assert.equal(paths.stackRoot, "/Users/someone/keelarr/stacks");
  assert.equal(paths.configRoot, "/Users/someone/keelarr/config");
  assert.equal(paths.mediaRoot, "/Users/someone/keelarr/media");
  assert.equal(paths.downloadsRoot, "/Users/someone/keelarr/media/downloads");
});

test("without mounted roots the generic defaults still apply", async () => {
  const paths = resolveGenericDockerSuggestedPaths({}, {
    preferredAdapterId: "generic-docker",
    mountedRoots: {}
  });

  assert.equal(paths.stackRoot, "/opt/keelarr/stacks");
  assert.equal(paths.mediaRoot, "/srv/media");
});

test("what the operator already chose outranks the mounted root", async () => {
  // Changing a root and re-detecting must not silently revert it to the mount.
  const paths = resolveGenericDockerSuggestedPaths(
    { initialized: true, mediaRoot: "/tank/media" },
    { mountedRoots: { mediaRoot: "/Users/someone/keelarr/media" } }
  );

  assert.equal(paths.mediaRoot, "/tank/media");
});

test("before the first save, placeholder settings lose to a real mount", async () => {
  // A fresh settings.json already carries generic defaults. Nobody picked them,
  // so preferring them over an actual mount is what produced a first-run
  // suggestion the controller could not see.
  const paths = resolveGenericDockerSuggestedPaths(
    { initialized: false, mediaRoot: "/srv/media", stackRoot: "/opt/keelarr/stacks" },
    { mountedRoots: { mediaRoot: "/Users/someone/keelarr/media", stackRoot: "/Users/someone/keelarr/stacks" } }
  );

  assert.equal(paths.mediaRoot, "/Users/someone/keelarr/media");
  assert.equal(paths.stackRoot, "/Users/someone/keelarr/stacks");
});

test("a directory the identity does not own and cannot write is reported as blocked", () => {
  // The exact shape a linuxserver-populated library takes: the app that made
  // the folder owns it at 755, so a second app running as a different uid gets
  // read and traverse but cannot create the file it came to write.
  assert.equal(identityCanWriteInto({ uid: 911, gid: 911, mode: 0o755 }, 1000, 1000), false);
  assert.equal(identityCanWriteInto({ uid: 911, gid: 911, mode: 0o755 }, 911, 911), true);

  // A world-writable share says yes to everyone, which is why checking only
  // the media root is not enough to trust.
  assert.equal(identityCanWriteInto({ uid: 0, gid: 0, mode: 0o777 }, 1000, 1000), true);

  // POSIX stops at the first matching class rather than falling through, so an
  // owner match without the write bit is a denial even when group would allow.
  assert.equal(identityCanWriteInto({ uid: 911, gid: 911, mode: 0o575 }, 911, 911), false);

  // Group ownership is the other way in.
  assert.equal(identityCanWriteInto({ uid: 0, gid: 911, mode: 0o775 }, 911, 911), true);

  assert.equal(identityCanWriteInto(null, 911, 911), null);
});

test("host validation warns when the library folders reject the configured PUID", async () => {
  // A media root that is writable by anyone, holding a library folder that is
  // not — the arrangement that passes a surface check and then fails on every
  // write, which is what this warning exists to catch.
  const root = await mkdtemp(path.join(os.tmpdir(), "keelarr-identity-validation-"));
  const stackRoot = path.join(root, "stacks");
  const configRoot = path.join(root, "config");
  const mediaRoot = path.join(root, "media");
  const downloadsRoot = path.join(mediaRoot, "downloads");
  const titleFolder = path.join(mediaRoot, "Movies", "Some Film (1971)");

  await mkdir(stackRoot, { recursive: true });
  await mkdir(configRoot, { recursive: true });
  await mkdir(downloadsRoot, { recursive: true });
  await mkdir(titleFolder, { recursive: true });
  await chmod(mediaRoot, 0o777);
  await chmod(path.join(mediaRoot, "Movies"), 0o777);
  await chmod(titleFolder, 0o755);

  const settings = {
    dockerBin: "/definitely-not-keelarr/docker",
    stackRoot,
    configRoot,
    mediaRoot,
    downloadsRoot,
    plexLogsRoot: "",
    selectedServiceIds: ["trailarr"]
  };

  // A uid this process is not, so the 755 title folder denies it.
  const foreign = await validateGenericDockerHost({ ...settings, puid: String(process.getuid() + 1), pgid: String(process.getgid() + 1) });
  assert.match(foreign.warnings.join(" "), /cannot write into 1 of 2 sampled library folders/i);
  assert.equal(foreign.fieldResults.identity.level, "warn");

  // The owning identity is allowed, and the warning goes away.
  const owner = await validateGenericDockerHost({ ...settings, puid: String(process.getuid()), pgid: String(process.getgid()) });
  assert.doesNotMatch(owner.warnings.join(" "), /sampled library folders/i);
  assert.equal(owner.fieldResults.identity.level, "info");
});
