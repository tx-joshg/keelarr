import test from "node:test";
import assert from "node:assert/strict";

import { ImportService } from "../src/lib/app-services/import-service.js";

test("adoptImportAsDraft writes draft files before persisting imported override state", async () => {
  const calls = [];
  const baseSettings = {
    initialized: true,
    selectedServiceIds: ["trailarr"],
    serviceOverrides: {},
    services: {}
  };
  const item = {
    containerId: "trailarrdemo",
    containerName: "trailarr",
    image: "nandyalu/trailarr:latest",
    serviceId: "trailarr",
    serviceName: "Trailarr",
    adoptable: true,
    recognized: true,
    mounts: [],
    envKeys: ["PUID", "PGID", "TZ"]
  };
  const preview = {
    supported: true,
    adoptable: true,
    source: {
      containerId: "trailarrdemo",
      containerName: "trailarr",
      image: "nandyalu/trailarr:latest"
    },
    target: {
      serviceId: "trailarr",
      serviceName: "Trailarr",
      image: "nandyalu/trailarr:latest",
      port: 7889,
      containerName: "trailarr",
      restartPolicy: "unless-stopped",
      networkMode: "bridge",
      stackDir: "/srv/keelarr/stacks/trailarr"
    },
    draft: {
      envKeys: ["PUID", "PGID", "TZ"]
    },
    draftArtifacts: {
      reviewSummaryPath: "/srv/keelarr/stacks/trailarr/import-summary.json",
      reviewNotesPath: "/srv/keelarr/stacks/trailarr/IMPORT-REVIEW.md"
    },
    recommendedSteps: [],
    warnings: [],
    preservation: []
  };

  const service = new ImportService({
    appendActivityImpl: async () => [],
    buildImportPreviewImpl: async () => preview,
    buildImportReviewArtifactsImpl: () => ({
      summary: { ok: true },
      markdown: "# Import Review"
    }),
    buildImportDraftArtifactsImpl: () => ({
      serviceId: "trailarr",
      serviceName: "Trailarr",
      image: "nandyalu/trailarr:latest",
      port: 7889,
      containerName: "trailarr",
      restartPolicy: "unless-stopped",
      networkMode: "bridge",
      envKeys: ["PUID", "PGID", "TZ"],
      stackDir: "/srv/keelarr/stacks/trailarr",
      composePath: "/srv/keelarr/stacks/trailarr/compose.yml",
      envPath: "/srv/keelarr/stacks/trailarr/.env",
      envExamplePath: "/srv/keelarr/stacks/trailarr/.env.example",
      reviewSummaryPath: "/srv/keelarr/stacks/trailarr/import-summary.json",
      reviewNotesPath: "/srv/keelarr/stacks/trailarr/IMPORT-REVIEW.md"
    }),
    loadSettingsImpl: async () => baseSettings,
    normalizeSettingsImpl: (input) => input,
    saveSettingsImpl: async (input) => {
      calls.push({ type: "save", input });
      return input;
    },
    scanDockerInventoryImpl: async () => ({
      items: [item]
    }),
    writeDraftFilesImpl: async (draft) => {
      calls.push({ type: "write", draft });
      return {
        serviceId: draft.serviceId,
        composePath: draft.composePath,
        envPath: draft.envPath,
        envExamplePath: draft.envExamplePath,
        reviewSummaryPath: draft.reviewSummaryPath,
        reviewNotesPath: draft.reviewNotesPath
      };
    }
  });

  await service.adoptImportAsDraft("trailarrdemo");

  assert.equal(calls[0].type, "write");
  assert.equal(calls[1].type, "save");
  assert.equal(calls[1].input.serviceOverrides.trailarr.mode, "imported-draft");
});

test("adopting a container whose real port collides with a selected app is refused before anything is written", async () => {
  const writes = [];
  const item = {
    containerId: "sonarr1", containerName: "sonarr", image: "lscr.io/linuxserver/sonarr:latest",
    serviceId: "sonarr", serviceName: "Sonarr", adoptable: true, recognized: true, mounts: [], envKeys: []
  };
  const service = new ImportService({
    appendActivityImpl: async () => [],
    buildImportPreviewImpl: async () => ({
      supported: true,
      adoptable: true,
      target: { serviceId: "sonarr", image: item.image, port: 7878, containerName: "sonarr", stackDir: "/srv/stacks/sonarr" },
      draft: { envKeys: [] }
    }),
    buildImportReviewArtifactsImpl: () => ({ summary: {}, markdown: "" }),
    buildImportDraftArtifactsImpl: () => ({}),
    loadSettingsImpl: async () => ({ initialized: true, selectedServiceIds: ["radarr"], serviceOverrides: {}, services: {} }),
    normalizeSettingsImpl: (input) => input,
    saveSettingsImpl: async (input) => {
      writes.push("save");
      return input;
    },
    scanDockerInventoryImpl: async () => ({ items: [item] }),
    writeDraftFilesImpl: async () => {
      writes.push("write");
      return {};
    }
  });

  await assert.rejects(() => service.adoptImportAsDraft("sonarr1"), /port 7878/);
  assert.deepEqual(writes, []);
});

test("an adoption records the specific address its port is bound to", async () => {
  const saved = [];
  const item = {
    containerId: "r1", containerName: "radarr", image: "lscr.io/linuxserver/radarr:latest",
    serviceId: "radarr", serviceName: "Radarr", adoptable: true, recognized: true, mounts: [], envKeys: [],
    ports: [{ hostIp: "192.168.1.10", hostPort: "8080", containerPort: "7878" }]
  };
  const service = new ImportService({
    appendActivityImpl: async () => [],
    buildImportPreviewImpl: async () => ({
      supported: true,
      adoptable: true,
      target: { serviceId: "radarr", image: item.image, port: 8080, containerName: "radarr", stackDir: "/srv/stacks/radarr" },
      draft: { envKeys: [] }
    }),
    buildImportReviewArtifactsImpl: () => ({ summary: {}, markdown: "" }),
    buildImportDraftArtifactsImpl: () => ({}),
    loadSettingsImpl: async () => ({
      initialized: true,
      selectedServiceIds: ["sonarr"],
      serviceOverrides: { sonarr: { mode: "imported-draft", port: 8080, hostIp: "192.168.1.11" } },
      services: {}
    }),
    normalizeSettingsImpl: (input) => input,
    saveSettingsImpl: async (input) => {
      saved.push(input);
      return input;
    },
    scanDockerInventoryImpl: async () => ({ items: [item] }),
    writeDraftFilesImpl: async () => ({})
  });

  await service.adoptImportAsDraft("r1");
  assert.equal(saved.at(-1).serviceOverrides.radarr.hostIp, "192.168.1.10");
});
