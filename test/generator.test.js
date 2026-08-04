import test from "node:test";
import assert from "node:assert/strict";

import { buildServicesFromSelection, buildComposeSpec } from "../src/lib/service-catalog.js";
import { normalizeSettings } from "../src/lib/store.js";

test("builds a compose spec with expected media and config mounts", () => {
  const settings = normalizeSettings({
    hostUrl: "http://nas.local",
    stackRoot: "/share/Container/docker",
    configRoot: "/share/Container",
    mediaRoot: "/share/Media",
    downloadsRoot: "/share/Media/Downloads",
    selectedServiceIds: ["radarr"]
  });

  const services = buildServicesFromSelection(settings, ["radarr"]);
  const composeSpec = buildComposeSpec(settings, services.radarr);

  assert.equal(composeSpec.services.radarr.image, "lscr.io/linuxserver/radarr:latest");
  assert.deepEqual(composeSpec.services.radarr.ports, ["${PORT}:7878"]);
  assert.deepEqual(composeSpec.services.radarr.volumes, [
    "${CONFIG_DIR}:/config",
    "${MEDIA_DIR}:/Media"
  ]);
});

