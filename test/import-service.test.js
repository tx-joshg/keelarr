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
      stackDir: "/srv/stackarr/stacks/trailarr"
    },
    draft: {
      envKeys: ["PUID", "PGID", "TZ"]
    },
    draftArtifacts: {
      reviewSummaryPath: "/srv/stackarr/stacks/trailarr/import-summary.json",
      reviewNotesPath: "/srv/stackarr/stacks/trailarr/IMPORT-REVIEW.md"
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
      stackDir: "/srv/stackarr/stacks/trailarr",
      composePath: "/srv/stackarr/stacks/trailarr/compose.yml",
      envPath: "/srv/stackarr/stacks/trailarr/.env",
      envExamplePath: "/srv/stackarr/stacks/trailarr/.env.example",
      reviewSummaryPath: "/srv/stackarr/stacks/trailarr/import-summary.json",
      reviewNotesPath: "/srv/stackarr/stacks/trailarr/IMPORT-REVIEW.md"
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
