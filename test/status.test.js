import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildDashboardState, selectInventoryItemForService } from "../src/lib/status.js";

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

test("buildDashboardState monitors a detected live container before Stackarr owns the compose runtime", async () => {
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
        composePath: "/tmp/stackarr-missing/compose.yml",
        envPath: "/tmp/stackarr-missing/.env",
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
  assert.equal(service.updateStatus, "unmanaged");
});

test("buildDashboardState keeps imported drafts out of managed upgrade mode until cutover completes", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "stackarr-status-"));
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
