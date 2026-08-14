import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildDashboardState, isComposeManagedBy, selectInventoryItemForService, deriveReachable, findUnpublishedPorts } from "../src/lib/status.js";

test("selectInventoryItemForService prefers imported source identifiers before generic matches", () => {
  const service = {
    id: "trailarr",
    containerName: "trailarr",
    sourceContainerId: "preferred123",
    sourceContainerName: "trailarr-old"
  };
  const items = [
    {
      containerId: "fallback456",
      containerName: "trailarr",
      recognized: true,
      serviceId: "trailarr"
    },
    {
      containerId: "preferred123",
      containerName: "trailarr-old",
      recognized: true,
      serviceId: "trailarr"
    }
  ];

  const selected = selectInventoryItemForService(service, items);

  assert.equal(selected?.containerId, "preferred123");
});

test("buildDashboardState monitors a detected live container before Keelarr owns the compose runtime", async () => {
  const settings = {
    initialized: true,
    selectedServiceIds: ["trailarr"],
    services: {
      trailarr: {
        id: "trailarr",
        name: "Trailarr",
        image: "nandyalu/trailarr:latest",
        sourceImage: null,
        sourceContainerId: null,
        sourceContainerName: null,
        containerName: "trailarr",
        composePath: "/tmp/keelarr-missing/compose.yml",
        envPath: "/tmp/keelarr-missing/.env",
        appUrl: "http://localhost:7889",
        port: 7889,
        managedMode: "catalog",
        restartPolicy: "unless-stopped",
        networkMode: "bridge"
      }
    },
    downloadsRoot: "/share/Media/Downloads",
    mediaRoot: "/share/Media",
    plexLogsRoot: "/share/Container/plex/Logs",
    hostUrl: "http://localhost"
  };

  const state = await buildDashboardState(settings, {
    readActivityImpl: async () => [],
    readUpdateStateImpl: async () => ({}),
    scanDockerInventoryImpl: async () => ({
      items: [
        {
          recognized: true,
          serviceId: "trailarr",
          containerId: "trailarr12345",
          containerName: "trailarr",
          image: "nandyalu/trailarr:latest",
          imageId: "sha256:trailarrimage123",
          status: "running",
          healthStatus: "healthy",
          resourceUsage: {
            cpuPercent: 2.35,
            cpuPercentDisplay: "2.35%",
            memoryUsageDisplay: "311.5MiB / 7.663GiB",
            memoryPercent: 3.97,
            memoryPercentDisplay: "3.97%"
          },
          ports: [{ hostPort: "7889", display: "0.0.0.0:7889->7889/tcp" }],
          networks: [{ name: "bridge", address: "203.0.113.7" }],
          restartPolicy: "unless-stopped",
          networkMode: "bridge"
        }
      ]
    }),
    composePsImpl: async () => {
      throw new Error("composePs should not run for a service with no generated files");
    },
    probeServiceImpl: async () => {
      throw new Error("probeService should be skipped for localhost-based URLs");
    }
  });

  const [service] = state.services;
  assert.equal(service.runtimeSource, "inventory");
  assert.equal(service.managementState, "detected");
  assert.equal(service.runtimeStatus, "running");
  assert.equal(service.healthStatus, "healthy");
  assert.equal(service.reachable, true);
  assert.equal(service.observedContainerName, "trailarr");
  assert.equal(service.observedImage, "nandyalu/trailarr:latest");
  assert.equal(service.observedImageId, "sha256:trailarrimage123");
  assert.equal(service.resourceUsage?.cpuPercentDisplay, "2.35%");
  assert.equal(service.updateStatus, "unmanaged");
});

test("buildDashboardState keeps imported drafts out of managed upgrade mode until cutover completes", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "keelarr-status-"));
  const composePath = path.join(tempRoot, "compose.yml");
  const envPath = path.join(tempRoot, ".env");
  await writeFile(composePath, "name: trailarr\n", "utf8");
  await writeFile(envPath, "TZ=America/Chicago\n", "utf8");

  const settings = {
    initialized: true,
    selectedServiceIds: ["trailarr"],
    services: {
      trailarr: {
        id: "trailarr",
        name: "Trailarr",
        image: "nandyalu/trailarr:latest",
        sourceImage: "nandyalu/trailarr:latest",
        sourceContainerId: "trailarr12345",
        sourceContainerName: "trailarr",
        containerName: "trailarr",
        composePath,
        envPath,
        appUrl: "http://localhost:7889",
        port: 7889,
        managedMode: "imported-draft",
        restartPolicy: "unless-stopped",
        networkMode: "bridge"
      }
    },
    downloadsRoot: "/share/Media/Downloads",
    mediaRoot: "/share/Media",
    plexLogsRoot: "/share/Container/plex/Logs",
    hostUrl: "http://localhost"
  };

  const state = await buildDashboardState(settings, {
    readActivityImpl: async () => [],
    readUpdateStateImpl: async () => ({
      trailarr: {
        status: "ready",
        checkedAt: "2026-08-05T00:00:00.000Z"
      }
    }),
    scanDockerInventoryImpl: async () => ({
      items: [
        {
          recognized: true,
          serviceId: "trailarr",
          containerId: "trailarr12345",
          containerName: "trailarr",
          image: "nandyalu/trailarr:latest",
          imageId: "sha256:trailarrimage123",
          status: "running",
          healthStatus: null,
          resourceUsage: {
            cpuPercent: 2.35,
            cpuPercentDisplay: "2.35%",
            memoryUsageDisplay: "311.5MiB / 7.663GiB",
            memoryPercent: 3.97,
            memoryPercentDisplay: "3.97%"
          },
          ports: [{ hostPort: "7889", display: "0.0.0.0:7889->7889/tcp" }],
          networks: [{ name: "bridge", address: "203.0.113.7" }],
          restartPolicy: "unless-stopped",
          networkMode: "bridge"
        }
      ]
    }),
    composePsImpl: async () => ({
      ok: true,
      data: []
    }),
    probeServiceImpl: async () => ({
      reachable: true,
      latencyMs: 42,
      httpStatus: 200,
      error: null
    })
  });

  const [service] = state.services;
  assert.equal(service.generated, true);
  assert.equal(service.runtimeSource, "inventory");
  assert.equal(service.managementState, "draft");
  assert.equal(service.updateStatus, "cutover-pending");
});

test("buildDashboardState reports a cut-over service as managed once Compose owns it", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "keelarr-status-"));
  const composePath = path.join(tempRoot, "compose.yml");
  const envPath = path.join(tempRoot, ".env");
  await writeFile(composePath, "name: trailarr\n", "utf8");
  await writeFile(envPath, "TZ=America/Chicago\n", "utf8");

  const settings = {
    initialized: true,
    selectedServiceIds: ["trailarr"],
    services: {
      trailarr: {
        id: "trailarr",
        name: "Trailarr",
        image: "nandyalu/trailarr:latest",
        containerName: "trailarr",
        composePath,
        envPath,
        appUrl: "http://localhost:7889",
        port: 7889,
        managedMode: "imported",
        restartPolicy: "unless-stopped",
        networkMode: "bridge"
      }
    },
    downloadsRoot: "/share/Media/Downloads",
    mediaRoot: "/share/Media",
    plexLogsRoot: "/share/Container/plex/Logs",
    hostUrl: "http://localhost"
  };

  const dependencies = {
    readActivityImpl: async () => [],
    readUpdateStateImpl: async () => ({ trailarr: { status: "current", checkedAt: "2026-08-05T00:00:00.000Z" } }),
    // Compose ownership is read from the container's own labels now, which the
    // inventory scan already fetches — no `docker compose ps` per service.
    scanDockerInventoryImpl: async () => ({
      items: [{
        recognized: true,
        serviceId: "trailarr",
        containerId: "abc123",
        containerName: "trailarr",
        image: "nandyalu/trailarr:latest",
        status: "running",
        healthStatus: null,
        compose: {
          project: "trailarr",
          service: "trailarr",
          configFiles: composePath
        }
      }]
    }),
    probeServiceImpl: async () => ({ reachable: true, latencyMs: 12, httpStatus: 200, error: null })
  };

  const state = await buildDashboardState(settings, dependencies);
  const [service] = state.services;

  assert.equal(service.managementState, "managed");
  assert.equal(service.updateStatus, "current");
});

test("buildDashboardState does not invite a second cutover when an imported service is down", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "keelarr-status-"));
  const composePath = path.join(tempRoot, "compose.yml");
  const envPath = path.join(tempRoot, ".env");
  await writeFile(composePath, "name: trailarr\n", "utf8");
  await writeFile(envPath, "TZ=America/Chicago\n", "utf8");

  const settings = {
    initialized: true,
    selectedServiceIds: ["trailarr"],
    services: {
      trailarr: {
        id: "trailarr",
        name: "Trailarr",
        image: "nandyalu/trailarr:latest",
        containerName: "trailarr",
        composePath,
        envPath,
        appUrl: "http://localhost:7889",
        port: 7889,
        managedMode: "imported",
        restartPolicy: "unless-stopped",
        networkMode: "bridge"
      }
    },
    downloadsRoot: "/share/Media/Downloads",
    mediaRoot: "/share/Media",
    plexLogsRoot: "/share/Container/plex/Logs",
    hostUrl: "http://localhost"
  };

  const state = await buildDashboardState(settings, {
    readActivityImpl: async () => [],
    readUpdateStateImpl: async () => ({}),
    scanDockerInventoryImpl: async () => ({ items: [] }),
    composePsImpl: async () => ({ ok: true, data: [] }),
    probeServiceImpl: async () => ({ reachable: false, latencyMs: null, httpStatus: null, error: "down" })
  });
  const [service] = state.services;

  assert.equal(service.updateStatus, "unmanaged");
});

test("a catalog service with files but no container is not reported as cutover-pending", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "keelarr-status-"));
  const composePath = path.join(tempRoot, "compose.yml");
  const envPath = path.join(tempRoot, ".env");
  await writeFile(composePath, "name: readarr\n", "utf8");
  await writeFile(envPath, "TZ=America/Chicago\n", "utf8");

  const settings = {
    initialized: true,
    selectedServiceIds: ["readarr"],
    services: {
      readarr: {
        id: "readarr",
        name: "Readarr",
        image: "lscr.io/linuxserver/readarr:develop",
        containerName: "readarr",
        composePath,
        envPath,
        appUrl: "http://198.51.100.2:8787",
        port: 8787,
        managedMode: "catalog",
        restartPolicy: "unless-stopped",
        networkMode: "bridge"
      }
    },
    downloadsRoot: "/share/Media/Downloads",
    mediaRoot: "/share/Media",
    plexLogsRoot: "",
    hostUrl: "http://198.51.100.2"
  };

  const state = await buildDashboardState(settings, {
    readActivityImpl: async () => [],
    readUpdateStateImpl: async () => ({}),
    scanDockerInventoryImpl: async () => ({ items: [] }),
    composePsImpl: async () => ({ ok: true, data: [] }),
    probeServiceImpl: async () => ({ reachable: false, latencyMs: null, httpStatus: null, error: "refused" })
  });

  // "cutover-pending" is import language; a failed catalog install has
  // nothing to cut over.
  assert.equal(state.services[0].updateStatus, "not-deployed");
});

test("compose ownership is matched by the container's own labels", () => {
  const service = { id: "radarr", composePath: "/share/Container/docker/radarr/compose.yml" };

  assert.equal(isComposeManagedBy({ compose: { project: "radarr", configFiles: service.composePath } }, service), true);
  // A container from a different project that happens to share a name is not ours.
  assert.equal(isComposeManagedBy({ compose: { project: "radarr", configFiles: "/somewhere/else/compose.yml" } }, service), false);
  // Older Compose versions omit config_files; fall back to the project name.
  assert.equal(isComposeManagedBy({ compose: { project: "radarr", configFiles: null } }, service), true);
  assert.equal(isComposeManagedBy({ compose: { project: "other", configFiles: null } }, service), false);
  // A plain `docker run` container carries no compose labels at all.
  assert.equal(isComposeManagedBy({ compose: null }, service), false);
  assert.equal(isComposeManagedBy(null, service), false);
});

test("a running container is not called reachable when nothing probed it", () => {
  // The false green: SABnzbd's port never published, so nothing on the host
  // could open it — and the address shown belonged to whichever service did
  // claim that port. Keelarr called it reachable because the process was up.
  assert.equal(deriveReachable({ status: "running" }, null), null);
  assert.equal(deriveReachable({ status: "running" }, { reachable: false }), null);
});

test("reachable stays true only when something actually answered", () => {
  assert.equal(deriveReachable({ status: "running" }, { reachable: true }), true);
  assert.equal(deriveReachable({ status: "running", healthStatus: "healthy" }, null), true);
});

test("a stopped container is unreachable, which is a fact rather than a guess", () => {
  assert.equal(deriveReachable({ status: "exited" }, null), false);
  assert.equal(deriveReachable({ status: "running", healthStatus: "unhealthy" }, null), false);
});

test("a declared port with no host binding is reported", () => {
  const ports = [
    { containerPort: "8080/tcp", hostIp: null, hostPort: null },
    { containerPort: "9696/tcp", hostIp: "0.0.0.0", hostPort: "9696" }
  ];

  assert.deepEqual(findUnpublishedPorts(ports), ["8080/tcp"]);
  assert.deepEqual(findUnpublishedPorts([]), []);
});
