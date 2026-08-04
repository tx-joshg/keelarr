import test from "node:test";
import assert from "node:assert/strict";

import { buildImportPreview } from "../src/lib/import-planner.js";
import { normalizeSettings } from "../src/lib/store.js";

const baseSettings = normalizeSettings({
  initialized: true,
  stackRoot: "/share/Container/docker",
  configRoot: "/share/Container",
  mediaRoot: "/share/Media",
  downloadsRoot: "/share/Media/Downloads",
  plexLogsRoot: "/share/Container/plex/Logs",
  hostUrl: "http://nas.local",
  selectedServiceIds: ["trailarr", "tautulli"]
});

test("builds a focused import preview for a recognized service", async () => {
  const preview = await buildImportPreview(baseSettings, {
    containerId: "trailarrdemo",
    containerName: "trailarr",
    image: "nandyalu/trailarr:latest",
    recognized: true,
    serviceId: "trailarr",
    serviceName: "Trailarr",
    matchedBy: "name",
    status: "running",
    restartPolicy: "unless-stopped",
    networkMode: "bridge",
    ports: [],
    mounts: [
      { source: "/share/Container/trailarr/config", target: "/config" },
      { source: "/share/Media", target: "/Media" }
    ],
    networks: [],
    envKeys: [],
    issues: [],
    adoptable: true
  });

  assert.equal(preview.supported, true);
  assert.equal(preview.target.serviceId, "trailarr");
  assert.equal(preview.preservation.length, 2);
  assert.equal(preview.preservation.some((item) => item.label === "Plex Logs"), false);
});

test("surfaces unresolved plex log issues in the import preview", async () => {
  const preview = await buildImportPreview(baseSettings, {
    containerId: "tautullidemo",
    containerName: "tautulli",
    image: "ghcr.io/tautulli/tautulli:latest",
    recognized: true,
    serviceId: "tautulli",
    serviceName: "Tautulli",
    matchedBy: "name",
    status: "running",
    restartPolicy: "unless-stopped",
    networkMode: "bridge",
    ports: [],
    mounts: [
      { source: "/share/Container/tautulli/config", target: "/config" }
    ],
    networks: [],
    envKeys: [],
    issues: [
      {
        level: "error",
        message: "Missing expected /plex_logs mount for Tautulli."
      }
    ],
    adoptable: false
  });

  assert.equal(preview.adoptable, false);
  assert.equal(preview.preservation.some((item) => item.label === "Plex Logs" && item.status === "missing"), true);
});
