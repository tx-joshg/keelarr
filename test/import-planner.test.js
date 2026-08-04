import test from "node:test";
import assert from "node:assert/strict";

import { buildImportDraftArtifacts, buildImportPreview } from "../src/lib/import-planner.js";
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
    envKeys: ["PGID", "PUID", "TZ"],
    issues: [],
    adoptable: true
  });

  assert.equal(preview.supported, true);
  assert.equal(preview.target.serviceId, "trailarr");
  assert.equal(preview.preservation.length, 2);
  assert.equal(preview.preservation.some((item) => item.label === "Plex Logs"), false);
  assert.match(preview.draft.composeYaml, /environment:/);
  assert.match(preview.draft.composeYaml, /PUID: \$\{PUID\}/);
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

test("builds a managed draft that preserves image, host networking details, and named volumes", () => {
  const draft = buildImportDraftArtifacts(baseSettings, {
    containerId: "sabdemo",
    containerName: "sabnzbd",
    image: "linuxserver/sabnzbd:latest",
    recognized: true,
    serviceId: "sabnzbd",
    serviceName: "SABnzbd",
    matchedBy: "name",
    status: "running",
    restartPolicy: "unless-stopped",
    networkMode: "qnet-static-eth1",
    ports: [],
    mounts: [
      {
        type: "bind",
        source: "/share/Media",
        target: "/Media",
        mode: "rw",
        name: null
      },
      {
        type: "volume",
        source: "/var/lib/docker/volumes/sab-config/_data",
        target: "/config",
        mode: "rw",
        name: "3095a425908172de24336c936d45618ce4f19647ea45f9894ee73415afe6237c"
      }
    ],
    networks: [
      {
        name: "qnet-static-eth1",
        address: "198.51.100.10"
      }
    ],
    envKeys: ["PUID", "PGID", "TZ", "API_KEY"],
    environment: {
      PUID: "1000",
      PGID: "1000",
      TZ: "America/Chicago",
      API_KEY: "secret-value",
      PATH: "/usr/local/bin"
    },
    command: [],
    entrypoint: ["/init"],
    issues: [],
    adoptable: true
  });

  assert.match(draft.composeYaml, /image: linuxserver\/sabnzbd:latest/);
  assert.match(draft.composeYaml, /external: true/);
  assert.match(draft.composeYaml, /qnet-static-eth1/);
  assert.match(draft.composeYaml, /ipv4_address: 198.51.100.10/);
  assert.match(draft.composeYaml, /entrypoint:/);
  assert.match(draft.envText, /API_KEY=secret-value/);
  assert.doesNotMatch(draft.envText, /PATH=/);
  assert.match(draft.envExampleText, /API_KEY=/);
});
