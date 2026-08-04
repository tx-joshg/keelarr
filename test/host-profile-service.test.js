import test from "node:test";
import assert from "node:assert/strict";

import { HostProfileService } from "../src/lib/app-services/host-profile-service.js";

test("resolveStateSettings keeps initialized settings and returns host inspection", async () => {
  const settings = {
    initialized: true,
    adapterType: "qnap",
    hostLabel: "QNAP NAS",
    dockerBin: "/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker",
    stackRoot: "/share/Container/docker",
    configRoot: "/share/Container",
    mediaRoot: "/share/Media",
    downloadsRoot: "/share/Media/Downloads",
    plexLogsRoot: "/share/Container/plex/Logs",
    hostUrl: "http://nas.local",
    tz: "America/Chicago",
    puid: "1000",
    pgid: "1000",
    ombiVersion: "latest",
    selectedServiceIds: ["trailarr", "tautulli"],
    services: {}
  };

  const service = new HostProfileService({
    loadSettingsImpl: async () => settings,
    detectHostEnvironmentImpl: async () => ({
      selected: {
        adapterId: "qnap",
        label: "QNAP / Container Station",
        suggestedSettings: {
          adapterType: "qnap",
          hostLabel: "QNAP NAS"
        }
      },
      detections: [{ adapterId: "qnap", label: "QNAP / Container Station", score: 95 }]
    }),
    normalizeSettingsImpl: (input) => input,
    validateHostProfileImpl: async () => ({
      ok: true,
      errors: [],
      warnings: [],
      fieldResults: {
        dockerBin: {
          ok: true,
          level: "info",
          value: settings.dockerBin,
          message: "Docker and Compose validated."
        }
      }
    })
  });

  const result = await service.resolveStateSettings();

  assert.equal(result.settings, settings);
  assert.equal(result.hostDetection.selected.adapterId, "qnap");
  assert.equal(result.hostDetection.validation.ok, true);
});

test("detectHost returns effective settings and validation details", async () => {
  const service = new HostProfileService({
    detectHostEnvironmentImpl: async () => ({
      selected: {
        adapterId: "qnap",
        label: "QNAP / Container Station",
        suggestedSettings: {
          adapterType: "qnap",
          hostLabel: "QNAP NAS",
          dockerBin: "/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker",
          stackRoot: "/share/Container/docker",
          configRoot: "/share/Container",
          mediaRoot: "/share/Media",
          downloadsRoot: "/share/Media/Downloads",
          plexLogsRoot: "/share/Container/plex/Logs"
        },
        fieldSuggestions: {
          dockerBin: {
            value: "/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker",
            confidence: "high",
            source: "qnap-detection"
          }
        }
      },
      detections: [
        {
          adapterId: "qnap",
          label: "QNAP / Container Station",
          score: 95
        }
      ]
    }),
    loadSettingsImpl: async () => ({
      initialized: false,
      hostUrl: "http://nas.local",
      selectedServiceIds: ["trailarr", "tautulli"]
    }),
    validateHostProfileImpl: async (settings) => ({
      ok: true,
      errors: [],
      warnings: ["Tautulli is selected but Plex logs path is blank."],
      fieldResults: {
        dockerBin: {
          ok: true,
          level: "info",
          value: settings.dockerBin,
          message: "Docker and Compose validated."
        }
      }
    })
  });

  const result = await service.detectHost({
    plexLogsRoot: ""
  });

  assert.equal(result.selected.adapterId, "qnap");
  assert.equal(result.validation.ok, true);
  assert.equal(result.effectiveSettings.stackRoot, "/share/Container/docker");
  assert.equal(result.effectiveSettings.plexLogsRoot, "");
  assert.deepEqual(result.validation.warnings, ["Tautulli is selected but Plex logs path is blank."]);
});

test("prepareSetup rejects invalid Docker validation before saving settings", async () => {
  const service = new HostProfileService({
    appendActivityImpl: async () => {
      throw new Error("appendActivity should not run when validation fails");
    },
    detectHostEnvironmentImpl: async () => ({
      selected: {
        adapterId: "generic-docker",
        suggestedSettings: {
          dockerBin: "docker",
          stackRoot: "/srv/stackarr/stacks",
          configRoot: "/srv/stackarr/config",
          mediaRoot: "/srv/media",
          downloadsRoot: "/srv/media/downloads",
          hostLabel: "Generic Docker Host"
        }
      },
      detections: []
    }),
    saveSettingsImpl: async () => {
      throw new Error("saveSettings should not run when validation fails");
    },
    validateHostProfileImpl: async () => ({
      ok: false,
      errors: ["Docker binary could not be executed: docker."],
      warnings: []
    }),
    writeStacksImpl: async () => {
      throw new Error("writeStacks should not run when validation fails");
    }
  });

  await assert.rejects(
    service.prepareSetup({
      adapterType: "generic-docker",
      hostLabel: "Broken Docker Host",
      projectName: "Stackarr",
      hostUrl: "http://nas.local",
      dockerBin: "docker",
      stackRoot: "/srv/stackarr/stacks",
      configRoot: "/srv/stackarr/config",
      mediaRoot: "/srv/media",
      downloadsRoot: "/srv/media/downloads",
      plexLogsRoot: "",
      tz: "America/Chicago",
      puid: "1000",
      pgid: "1000",
      ombiVersion: "latest",
      selectedServiceIds: ["radarr"]
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /Docker binary could not be executed/i);
      assert.equal(error.details?.ok, false);
      return true;
    }
  );
});

test("prepareSetup preserves existing service overrides when saving host settings", async () => {
  let savedPayload = null;

  const service = new HostProfileService({
    appendActivityImpl: async () => [],
    detectHostEnvironmentImpl: async () => ({
      selected: {
        adapterId: "generic-docker",
        suggestedSettings: {
          adapterType: "generic-docker",
          hostLabel: "Generic Docker Host",
          dockerBin: "docker",
          stackRoot: "/srv/stackarr/stacks",
          configRoot: "/srv/stackarr/config",
          mediaRoot: "/srv/media",
          downloadsRoot: "/srv/media/downloads",
          plexLogsRoot: ""
        }
      },
      detections: []
    }),
    loadSettingsImpl: async () => ({
      initialized: true,
      projectName: "Stackarr",
      adapterType: "generic-docker",
      hostLabel: "Generic Docker Host",
      dockerBin: "docker",
      stackRoot: "/srv/stackarr/stacks",
      configRoot: "/srv/stackarr/config",
      mediaRoot: "/srv/media",
      downloadsRoot: "/srv/media/downloads",
      plexLogsRoot: "",
      hostUrl: "http://old-host.local",
      tz: "America/Chicago",
      puid: "1000",
      pgid: "1000",
      ombiVersion: "latest",
      selectedServiceIds: ["trailarr"],
      serviceOverrides: {
        trailarr: {
          mode: "imported-draft",
          image: "nandyalu/trailarr:custom",
          port: 7889,
          containerName: "trailarr",
          restartPolicy: "unless-stopped",
          networkMode: "bridge",
          envKeys: ["PUID", "PGID", "TZ"],
          sourceContainerId: "trailarrdemo",
          sourceContainerName: "trailarr",
          sourceImage: "nandyalu/trailarr:custom",
          reviewSummaryPath: "/srv/stackarr/stacks/trailarr/import-summary.json",
          reviewNotesPath: "/srv/stackarr/stacks/trailarr/IMPORT-REVIEW.md",
          importedAt: "2026-08-04T12:00:00.000Z"
        }
      },
      services: {}
    }),
    normalizeSettingsImpl: (input) => input,
    saveSettingsImpl: async (input) => {
      savedPayload = input;
      return input;
    },
    validateHostProfileImpl: async () => ({
      ok: true,
      errors: [],
      warnings: [],
      fieldResults: {}
    }),
    writeStacksImpl: async () => []
  });

  await service.prepareSetup({
    hostUrl: "http://nas.local",
    selectedServiceIds: ["trailarr"]
  });

  assert.equal(savedPayload.hostUrl, "http://nas.local");
  assert.equal(savedPayload.serviceOverrides.trailarr.mode, "imported-draft");
  assert.equal(savedPayload.serviceOverrides.trailarr.reviewSummaryPath, "/srv/stackarr/stacks/trailarr/import-summary.json");
});
