import test from "node:test";
import assert from "node:assert/strict";

import { HostProfileService } from "../src/lib/app-services/host-profile-service.js";
import { normalizeSettings } from "../src/lib/store.js";

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

test("resolveStateSettings applies the best detected host profile on first run", async () => {
  let capturedPreferredAdapterId = "not-set";

  const service = new HostProfileService({
    loadSettingsImpl: async () => ({
      initialized: false,
      adapterType: "generic-docker",
      hostLabel: "Docker Host",
      dockerBin: "docker",
      stackRoot: "/opt/stackarr/stacks",
      configRoot: "/srv/stackarr/config",
      mediaRoot: "/srv/media",
      downloadsRoot: "/srv/media/downloads",
      plexLogsRoot: "",
      hostUrl: "http://localhost",
      tz: "America/Chicago",
      puid: "1000",
      pgid: "1000",
      ombiVersion: "latest",
      selectedServiceIds: ["trailarr", "tautulli"],
      services: {}
    }),
    detectHostEnvironmentImpl: async (_settings, options = {}) => {
      capturedPreferredAdapterId = options.preferredAdapterId ?? null;
      return {
        selected: {
          adapterId: "qnap",
          label: "QNAP / Container Station",
          suggestedSettings: {
            adapterType: "qnap",
            hostLabel: "QNAP NAS",
            dockerBin: "docker",
            stackRoot: "/share/Container/docker",
            configRoot: "/share/Container",
            mediaRoot: "/share/Media",
            downloadsRoot: "/share/Media/Downloads",
            plexLogsRoot: "/share/Container/plex/Logs"
          }
        },
        detections: [
          { adapterId: "qnap", label: "QNAP / Container Station", score: 95 },
          { adapterId: "generic-docker", label: "Generic Docker Host", score: 75 }
        ]
      };
    },
    normalizeSettingsImpl: (input) => input,
    validateHostProfileImpl: async (settings) => ({
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

  assert.equal(capturedPreferredAdapterId, null);
  assert.equal(result.settings.adapterType, "qnap");
  assert.equal(result.settings.hostLabel, "QNAP NAS");
  assert.equal(result.settings.stackRoot, "/share/Container/docker");
  assert.equal(result.settings.mediaRoot, "/share/Media");
  assert.equal(result.hostDetection.selected.adapterId, "qnap");
  assert.equal(result.hostDetection.effectiveSettings.adapterType, "qnap");
  assert.equal(result.hostDetection.effectiveSettings.stackRoot, "/share/Container/docker");
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

  const result = await service.detectHost({
    plexLogsRoot: ""
  });

  assert.equal(result.selected.adapterId, "qnap");
  assert.equal(result.validation.ok, true);
  assert.equal(result.effectiveSettings.stackRoot, "/share/Container/docker");
  assert.equal(result.effectiveSettings.plexLogsRoot, "/share/Container/plex/Logs");
  assert.deepEqual(result.validation.warnings, []);
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

test("saveProfile persists validated settings without generating stacks", async () => {
  let savedPayload = null;
  let writeStacksCalled = false;

  const service = new HostProfileService({
    appendActivityImpl: async () => [],
    detectHostEnvironmentImpl: async () => ({
      selected: {
        adapterId: "qnap",
        suggestedSettings: {
          adapterType: "qnap",
          hostLabel: "QNAP NAS",
          dockerBin: "docker",
          stackRoot: "/share/Container/docker",
          configRoot: "/share/Container",
          mediaRoot: "/share/Media",
          downloadsRoot: "/share/Media/Downloads",
          plexLogsRoot: "/share/Container/plex/Logs"
        }
      },
      detections: []
    }),
    loadSettingsImpl: async () => ({
      initialized: false,
      projectName: "Stackarr",
      hostUrl: "http://nas.local",
      selectedServiceIds: ["trailarr"]
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
    writeStacksImpl: async () => {
      writeStacksCalled = true;
      return [];
    }
  });

  const result = await service.saveProfile({
    preferredAdapterId: "qnap",
    hostUrl: "http://198.51.100.2"
  });

  assert.equal(result.settings.hostUrl, "http://198.51.100.2");
  assert.equal(savedPayload.adapterType, "qnap");
  assert.equal(savedPayload.preferredAdapterId, undefined);
  assert.equal(writeStacksCalled, false);
});

test("detectHost applies preferred adapter suggestions over stale saved host paths", async () => {
  const service = new HostProfileService({
    detectHostEnvironmentImpl: async () => ({
      selected: {
        adapterId: "qnap",
        suggestedSettings: {
          adapterType: "qnap",
          hostLabel: "QNAP NAS",
          dockerBin: "/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker",
          stackRoot: "/share/Container/docker",
          configRoot: "/share/Container",
          mediaRoot: "/share/Media",
          downloadsRoot: "/share/Media/Downloads",
          plexLogsRoot: "/share/Container/plex/Logs"
        }
      },
      detections: []
    }),
    loadSettingsImpl: async () => ({
      initialized: true,
      adapterType: "generic-docker",
      hostLabel: "Broken Docker Host",
      dockerBin: "/definitely-not-stackarr/docker",
      stackRoot: "/tmp/old-stacks",
      configRoot: "/tmp/old-config",
      mediaRoot: "/tmp/old-media",
      downloadsRoot: "/tmp/old-downloads",
      plexLogsRoot: "",
      hostUrl: "http://nas.local",
      tz: "America/Chicago",
      puid: "1000",
      pgid: "1000",
      ombiVersion: "latest",
      selectedServiceIds: ["trailarr"]
    }),
    normalizeSettingsImpl: (input) => input,
    validateHostProfileImpl: async (settings) => ({
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

  const result = await service.detectHost({
    preferredAdapterId: "qnap",
    adapterType: "generic-docker",
    hostLabel: "Broken Docker Host",
    dockerBin: "/definitely-not-stackarr/docker",
    stackRoot: "/tmp/old-stacks",
    configRoot: "/tmp/old-config",
    mediaRoot: "/tmp/old-media",
    downloadsRoot: "/tmp/old-downloads",
    plexLogsRoot: "",
    hostUrl: "http://nas.local",
    tz: "America/Chicago",
    puid: "1000",
    pgid: "1000",
    ombiVersion: "latest",
    selectedServiceIds: ["trailarr"]
  });

  assert.equal(result.effectiveSettings.adapterType, "qnap");
  assert.equal(result.effectiveSettings.hostLabel, "QNAP NAS");
  assert.equal(result.effectiveSettings.dockerBin, "/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker");
  assert.equal(result.effectiveSettings.stackRoot, "/share/Container/docker");
  assert.equal(result.effectiveSettings.configRoot, "/share/Container");
  assert.equal(result.effectiveSettings.mediaRoot, "/share/Media");
  assert.equal(result.effectiveSettings.downloadsRoot, "/share/Media/Downloads");
});

test("host detection is cached so a dashboard refresh does not re-probe Docker", async () => {
  let inspections = 0;
  const service = new HostProfileService({
    loadSettingsImpl: async () => normalizeSettings({ initialized: true, dockerBin: "docker" }),
    detectHostEnvironmentImpl: async () => {
      inspections += 1;
      return { selected: { adapterId: "qnap", suggestedSettings: {}, fieldSuggestions: {} }, detections: [] };
    },
    validateHostProfileImpl: async () => ({ ok: true, errors: [], warnings: [] }),
    appendActivityImpl: async () => {},
    saveSettingsImpl: async (next) => next
  });

  // Three dashboard refreshes in a row.
  await service.resolveStateSettings();
  await service.resolveStateSettings();
  await service.resolveStateSettings();

  // Probing the Docker binary on every poll cost seconds per refresh.
  assert.equal(inspections, 1);
});

test("saving or detecting invalidates the cached host detection", async () => {
  let inspections = 0;
  const service = new HostProfileService({
    loadSettingsImpl: async () => normalizeSettings({ initialized: true, dockerBin: "docker" }),
    detectHostEnvironmentImpl: async () => {
      inspections += 1;
      return { selected: { adapterId: "qnap", suggestedSettings: {}, fieldSuggestions: {} }, detections: [] };
    },
    validateHostProfileImpl: async () => ({ ok: true, errors: [], warnings: [] }),
    appendActivityImpl: async () => {},
    saveSettingsImpl: async (next) => next
  });

  await service.resolveStateSettings();
  assert.equal(inspections, 1);

  // An explicit detect must see the host as it is now, not a cached probe.
  await service.detectHost();
  assert.equal(inspections, 2);
});

test("a changed host profile is not served from the previous cache entry", async () => {
  let inspections = 0;
  let dockerBin = "docker";
  const service = new HostProfileService({
    loadSettingsImpl: async () => normalizeSettings({ initialized: true, dockerBin }),
    detectHostEnvironmentImpl: async () => {
      inspections += 1;
      return { selected: { adapterId: "qnap", suggestedSettings: {}, fieldSuggestions: {} }, detections: [] };
    },
    validateHostProfileImpl: async () => ({ ok: true, errors: [], warnings: [] }),
    appendActivityImpl: async () => {},
    saveSettingsImpl: async (next) => next
  });

  await service.resolveStateSettings();
  dockerBin = "/some/other/docker";
  await service.resolveStateSettings();

  assert.equal(inspections, 2);
});
