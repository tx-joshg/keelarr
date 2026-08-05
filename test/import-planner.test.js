import test from "node:test";
import assert from "node:assert/strict";

import {
  buildImportDraftArtifacts,
  buildImportPreview,
  buildImportReviewArtifacts,
  buildImportedPorts
} from "../src/lib/import-planner.js";
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
  assert.doesNotMatch(draft.composeYaml, /PATH:/);
  assert.equal(draft.envKeys.includes("PATH"), false);
  assert.match(draft.envExampleText, /API_KEY=/);
});

test("builds safe review artifacts for an import draft", async () => {
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
    ports: [
      {
        containerPort: "7889/tcp",
        hostIp: "0.0.0.0",
        hostPort: "7889",
        display: "0.0.0.0:7889->7889/tcp"
      }
    ],
    mounts: [
      { source: "/share/Container/trailarr/config", target: "/config", mode: "rw", type: "bind", name: null },
      { source: "/share/Media", target: "/Media", mode: "rw", type: "bind", name: null }
    ],
    networks: [{ name: "bridge", address: "203.0.113.7" }],
    envKeys: ["PUID", "PGID", "TZ"],
    issues: [],
    adoptable: true,
    command: [],
    entrypoint: ["/app/scripts/entrypoint.sh"]
  });

  const review = buildImportReviewArtifacts(preview, "2026-08-04T12:00:00.000Z");

  assert.equal(review.summary.source.containerName, "trailarr");
  assert.equal(review.summary.target.serviceId, "trailarr");
  assert.equal(review.summary.draft.envKeys.includes("PUID"), true);
  assert.match(review.markdown, /Import Review: trailarr -> Trailarr/);
  assert.match(review.markdown, /import-summary\.json/);
  assert.match(review.markdown, /Env Keys: PUID, PGID, TZ/);
});

test("collapses the duplicate IPv4/IPv6 publish Docker reports for one port", () => {
  // `docker run -p 3579:80` inspects as two entries. Emitting both makes
  // Compose bind 3579 twice and the second bind fails.
  const ports = buildImportedPorts([
    { containerPort: "80/tcp", hostIp: "0.0.0.0", hostPort: "3579" },
    { containerPort: "80/tcp", hostIp: "::", hostPort: "3579" }
  ]);

  assert.deepEqual(ports, ["3579:80/tcp"]);
});

test("keeps a specific host binding and brackets a literal IPv6 address", () => {
  assert.deepEqual(
    buildImportedPorts([{ containerPort: "80/tcp", hostIp: "198.51.100.9", hostPort: "3579" }]),
    ["198.51.100.9:3579:80/tcp"]
  );
  assert.deepEqual(
    buildImportedPorts([{ containerPort: "80/tcp", hostIp: "::1", hostPort: "3579" }]),
    ["[::1]:3579:80/tcp"]
  );
});

test("keeps distinct ports distinct while deduping", () => {
  assert.deepEqual(
    buildImportedPorts([
      { containerPort: "80/tcp", hostIp: "0.0.0.0", hostPort: "3579" },
      { containerPort: "80/tcp", hostIp: "::", hostPort: "3579" },
      { containerPort: "443/tcp", hostIp: "0.0.0.0", hostPort: "8443" }
    ]),
    ["3579:80/tcp", "8443:443/tcp"]
  );
});

test("an unpublished port keeps only the container side", () => {
  assert.deepEqual(buildImportedPorts([{ containerPort: "9000/tcp" }]), ["9000/tcp"]);
});

test("preserves network_mode bridge so a cutover does not move the container", () => {
  const draft = buildImportDraftArtifacts(baseSettings, {
    containerId: "abc",
    containerName: "ombi",
    serviceId: "ombi",
    image: "lscr.io/linuxserver/ombi:development",
    networkMode: "bridge",
    networks: [{ name: "bridge", address: "172.17.0.5" }],
    ports: [{ containerPort: "3579/tcp", hostIp: "0.0.0.0", hostPort: "3579" }],
    mounts: [{ type: "bind", source: "/share/Container/ombi/config", target: "/config", mode: "rw" }],
    environment: { PUID: "0" },
    envKeys: ["PUID"]
  });

  // Without this, Compose invents an <project>_default network and the
  // service silently moves off the network it was running on.
  assert.equal(draft.composeSpec.services.ombi.network_mode, "bridge");
  assert.equal(draft.composeSpec.services.ombi.networks, undefined);
  assert.deepEqual(draft.composeSpec.services.ombi.ports, ["3579:3579/tcp"]);
});

test("host networking still wins over the bridge default", () => {
  const draft = buildImportDraftArtifacts(baseSettings, {
    containerId: "abc",
    containerName: "radarr",
    serviceId: "radarr",
    image: "lscr.io/linuxserver/radarr:latest",
    networkMode: "host",
    networks: [{ name: "host" }],
    ports: [],
    mounts: [{ type: "bind", source: "/share/Container/radarr/config", target: "/config", mode: "rw" }],
    environment: {},
    envKeys: []
  });

  assert.equal(draft.composeSpec.services.radarr.network_mode, "host");
  assert.equal(draft.composeSpec.services.radarr.ports, undefined);
});

test("a custom external network is still emitted as a network, not a mode", () => {
  const draft = buildImportDraftArtifacts(baseSettings, {
    containerId: "abc",
    containerName: "sabnzbd",
    serviceId: "sabnzbd",
    image: "lscr.io/linuxserver/sabnzbd:latest",
    networkMode: "qnet-static",
    networks: [{ name: "qnet-static", address: "198.51.100.40" }],
    ports: [],
    mounts: [{ type: "bind", source: "/share/Container/sabnzbd/config", target: "/config", mode: "rw" }],
    environment: {},
    envKeys: []
  });

  assert.equal(draft.composeSpec.services.sabnzbd.network_mode, undefined);
  assert.deepEqual(draft.composeSpec.services.sabnzbd.networks, { "qnet-static": { ipv4_address: "198.51.100.40" } });
  assert.equal(draft.composeSpec.networks["qnet-static"].external, true);
});
