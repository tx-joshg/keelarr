import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildAdoptionIssues,
  diffEnvironment,
  matchSupportedService,
  normalizeImageRepository,
  shouldIncludeInventoryItem
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

test("does not flag named docker volumes as missing host paths", async () => {
  const mediaDir = await mkdtemp(path.join(os.tmpdir(), "stackarr-media-"));
  const serviceMatch = matchSupportedService({
    Name: "/radarr",
    Config: {
      Image: "linuxserver/radarr:latest"
    }
  });

  const issues = await buildAdoptionIssues(
    serviceMatch,
    {
      Config: {
        Image: "linuxserver/radarr:latest"
      },
      HostConfig: {
        NetworkMode: "host"
      }
    },
    [
      {
        type: "volume",
        source: "/var/lib/docker/volumes/radarr-config/_data",
        target: "/config",
        name: "radarr-config"
      },
      {
        type: "bind",
        source: mediaDir,
        target: "/Media"
      }
    ]
  );

  assert.equal(issues.some((issue) => issue.message.includes("Mount source does not exist")), false);
});

test("diffEnvironment removes image defaults from imported env keys", () => {
  const imported = diffEnvironment(
    {
      PATH: "/usr/local/bin",
      PUID: "1000",
      PGID: "1000",
      TZ: "America/Chicago",
      PYTHON_VERSION: "3.12.0"
    },
    {
      PATH: "/usr/local/bin",
      PYTHON_VERSION: "3.12.0"
    }
  );

  assert.deepEqual(imported, {
    PUID: "1000",
    PGID: "1000",
    TZ: "America/Chicago"
  });
});

test("shouldIncludeInventoryItem hides the stackarr controller and non-running containers", () => {
  assert.equal(shouldIncludeInventoryItem({
    containerName: "stackarr",
    status: "running"
  }), false);
  assert.equal(shouldIncludeInventoryItem({
    containerName: "radarr",
    status: "exited"
  }), false);
  assert.equal(shouldIncludeInventoryItem({
    containerName: "trailarr",
    status: "running"
  }), true);
});
