import test from "node:test";
import assert from "node:assert/strict";

import { applyDetectionSuggestions, pickBestHostDetection } from "../src/lib/host-adapters/index.js";

test("selects the highest-scoring host detection", () => {
  const selected = pickBestHostDetection([
    { adapterId: "generic-docker", score: 60 },
    { adapterId: "qnap", score: 90 }
  ]);

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
