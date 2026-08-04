import test from "node:test";
import assert from "node:assert/strict";

import { HostProfileService } from "../src/lib/app-services/host-profile-service.js";

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
