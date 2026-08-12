import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { applyDetectionSuggestions, pickBestHostDetection, pickHostDetection } from "../src/lib/host-adapters/index.js";
import { resolveGenericDockerSuggestedPaths, validateGenericDockerHost } from "../src/lib/host-adapters/generic-docker.js";

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
      stackRoot: "/opt/stackarr/stacks"
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
    stackRoot: "/opt/stackarr/stacks",
    configRoot: "/srv/stackarr/config",
    mediaRoot: "/srv/media",
    downloadsRoot: "/srv/media/downloads",
    plexLogsRoot: ""
  });
});

test("host validation fails when the saved Docker binary is invalid", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stackarr-host-validation-"));
  const stackRoot = path.join(root, "stacks");
  const configRoot = path.join(root, "config");
  const mediaRoot = path.join(root, "media");
  const downloadsRoot = path.join(mediaRoot, "downloads");

  await mkdir(stackRoot, { recursive: true });
  await mkdir(configRoot, { recursive: true });
  await mkdir(downloadsRoot, { recursive: true });

  const result = await validateGenericDockerHost({
    dockerBin: "/definitely-not-stackarr/docker",
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
      stackRoot: "/Users/someone/stackarr/stacks",
      configRoot: "/Users/someone/stackarr/config",
      mediaRoot: "/Users/someone/stackarr/media",
      downloadsRoot: "/Users/someone/stackarr/media/downloads"
    }
  });

  assert.equal(paths.stackRoot, "/Users/someone/stackarr/stacks");
  assert.equal(paths.configRoot, "/Users/someone/stackarr/config");
  assert.equal(paths.mediaRoot, "/Users/someone/stackarr/media");
  assert.equal(paths.downloadsRoot, "/Users/someone/stackarr/media/downloads");
});

test("without mounted roots the generic defaults still apply", async () => {
  const paths = resolveGenericDockerSuggestedPaths({}, {
    preferredAdapterId: "generic-docker",
    mountedRoots: {}
  });

  assert.equal(paths.stackRoot, "/opt/stackarr/stacks");
  assert.equal(paths.mediaRoot, "/srv/media");
});

test("what the operator already chose outranks the mounted root", async () => {
  // Changing a root and re-detecting must not silently revert it to the mount.
  const paths = resolveGenericDockerSuggestedPaths(
    { initialized: true, mediaRoot: "/tank/media" },
    { mountedRoots: { mediaRoot: "/Users/someone/stackarr/media" } }
  );

  assert.equal(paths.mediaRoot, "/tank/media");
});

test("before the first save, placeholder settings lose to a real mount", async () => {
  // A fresh settings.json already carries generic defaults. Nobody picked them,
  // so preferring them over an actual mount is what produced a first-run
  // suggestion the controller could not see.
  const paths = resolveGenericDockerSuggestedPaths(
    { initialized: false, mediaRoot: "/srv/media", stackRoot: "/opt/stackarr/stacks" },
    { mountedRoots: { mediaRoot: "/Users/someone/stackarr/media", stackRoot: "/Users/someone/stackarr/stacks" } }
  );

  assert.equal(paths.mediaRoot, "/Users/someone/stackarr/media");
  assert.equal(paths.stackRoot, "/Users/someone/stackarr/stacks");
});
