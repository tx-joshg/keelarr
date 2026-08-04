import test from "node:test";
import assert from "node:assert/strict";

import { normalizeSettings } from "../src/lib/store.js";

test("normalizes settings and builds selected services", () => {
  const settings = normalizeSettings({
    hostUrl: "http://198.51.100.2/",
    selectedServiceIds: ["radarr", "sonarr", "radarr"]
  });

  assert.equal(settings.hostUrl, "http://198.51.100.2");
  assert.deepEqual(settings.selectedServiceIds, ["radarr", "sonarr"]);
  assert.equal(settings.services.radarr.port, 7878);
  assert.equal(settings.services.sonarr.port, 8989);
});

