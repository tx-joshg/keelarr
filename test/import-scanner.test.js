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
  parseDockerStatsLine,
  readComposeLabels,
  readImageVersionLabel,
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

test("parseDockerStatsLine extracts cpu and memory usage details", () => {
  const parsed = parseDockerStatsLine('{"CPUPerc":"181.08%","ID":"8ce33fc56553","MemPerc":"3.97%","MemUsage":"311.5MiB / 7.663GiB","Name":"trailarr"}');

  assert.deepEqual(parsed, {
    containerId: "8ce33fc56553",
    containerName: "trailarr",
    cpuPercent: 181.08,
    cpuPercentDisplay: "181.08%",
    memoryUsageDisplay: "311.5MiB / 7.663GiB",
    memoryPercent: 3.97,
    memoryPercentDisplay: "3.97%"
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

test("readImageVersionLabel prefers the OCI release over branch-style labels", () => {
  assert.equal(
    readImageVersionLabel({ "org.opencontainers.image.version": "5.26.2.10099-ls278" }),
    "5.26.2.10099-ls278"
  );
  assert.equal(readImageVersionLabel({ "org.label-schema.version": "1.2.3" }), "1.2.3");
});

test("readImageVersionLabel ignores branch names that say nothing about the release", () => {
  // Tautulli labels its image "master", which is no more useful than ":latest".
  assert.equal(readImageVersionLabel({ "org.opencontainers.image.version": "master" }), null);
  assert.equal(readImageVersionLabel({ "org.opencontainers.image.version": "latest" }), null);
  assert.equal(readImageVersionLabel({ "org.opencontainers.image.version": "  " }), null);
  assert.equal(readImageVersionLabel(null), null);
  assert.equal(readImageVersionLabel({}), null);
});

test("readComposeLabels extracts compose ownership, and ignores plain containers", () => {
  assert.deepEqual(
    readComposeLabels({
      "com.docker.compose.project": "radarr",
      "com.docker.compose.service": "radarr",
      "com.docker.compose.project.config_files": "/share/Container/docker/radarr/compose.yml"
    }),
    { project: "radarr", service: "radarr", configFiles: "/share/Container/docker/radarr/compose.yml" }
  );

  // A `docker run` container has no compose labels.
  assert.equal(readComposeLabels({ "org.opencontainers.image.version": "1.0" }), null);
  assert.equal(readComposeLabels(null), null);
});
