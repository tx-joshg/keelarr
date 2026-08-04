import test from "node:test";
import assert from "node:assert/strict";

import { normalizeSettings } from "../src/lib/store.js";

test("normalizes settings and builds selected services", () => {
  const settings = normalizeSettings({
    hostUrl: "http://198.51.100.2/",
    selectedServiceIds: ["radarr", "sonarr", "radarr"],
    serviceOverrides: {
      radarr: {
        mode: "imported-draft",
        image: "linuxserver/radarr:nightly",
        port: 8788,
        containerName: "radarr-imported",
        restartPolicy: "always",
        networkMode: "host",
        envKeys: ["PUID", "PGID"],
        reviewSummaryPath: "/share/Container/docker/radarr/import-summary.json",
        reviewNotesPath: "/share/Container/docker/radarr/IMPORT-REVIEW.md"
      }
    }
  });

  assert.equal(settings.hostUrl, "http://198.51.100.2");
  assert.deepEqual(settings.selectedServiceIds, ["radarr", "sonarr"]);
  assert.equal(settings.services.radarr.port, 8788);
  assert.equal(settings.services.radarr.image, "linuxserver/radarr:nightly");
  assert.equal(settings.services.radarr.containerName, "radarr-imported");
  assert.equal(settings.services.radarr.managedMode, "imported-draft");
  assert.equal(settings.services.sonarr.port, 8989);
});
