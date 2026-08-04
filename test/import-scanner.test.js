import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildAdoptionIssues,
  matchSupportedService,
  normalizeImageRepository
} from "../src/lib/import-scanner.js";

test("normalizes image repositories across registry and tag differences", () => {
  assert.equal(normalizeImageRepository("lscr.io/linuxserver/ombi:latest"), "linuxserver/ombi");
  assert.equal(normalizeImageRepository("linuxserver/ombi:development"), "linuxserver/ombi");
  assert.equal(normalizeImageRepository("ghcr.io/tautulli/tautulli:latest"), "tautulli/tautulli");
});

test("matches a supported service by image even when the tag differs", () => {
  const match = matchSupportedService({
    Name: "/ombi-dev",
    Config: {
      Image: "linuxserver/ombi:development"
    }
  });

  assert.equal(match?.serviceId, "ombi");
  assert.equal(match?.matchedBy, "image");
});

test("flags missing required media mounts for adoptable services", async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "stackarr-import-"));
  const serviceMatch = matchSupportedService({
    Name: "/trailarr",
    Config: {
      Image: "nandyalu/trailarr:latest"
    }
  });

  const issues = await buildAdoptionIssues(
    serviceMatch,
    {
      Config: {
        Image: "nandyalu/trailarr:latest"
      },
      HostConfig: {
        NetworkMode: "bridge"
      }
    },
    [
      {
        source: configDir,
        target: "/config"
      }
    ]
  );

  assert.equal(issues.some((issue) => issue.message.includes("/Media")), true);
});
