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
