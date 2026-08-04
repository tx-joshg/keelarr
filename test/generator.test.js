import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildServicesFromSelection, buildComposeSpec } from "../src/lib/service-catalog.js";
import { writeDraftFiles } from "../src/lib/generator.js";
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

test("writes import review artifacts beside a managed draft", async () => {
  const stackDir = await mkdtemp(path.join(os.tmpdir(), "stackarr-draft-"));
  const result = await writeDraftFiles({
    serviceId: "trailarr",
    stackDir,
    composePath: path.join(stackDir, "compose.yml"),
    envPath: path.join(stackDir, ".env"),
    envExamplePath: path.join(stackDir, ".env.example"),
    composeYaml: "name: trailarr\nservices:\n  trailarr:\n    image: nandyalu/trailarr:latest\n",
    envText: "PUID=1000\n",
    envExampleText: "PUID=\n",
    reviewSummary: {
      source: {
        containerName: "trailarr"
      }
    },
    reviewNotes: "# Import Review\n"
  });

  const reviewSummary = JSON.parse(await readFile(result.reviewSummaryPath, "utf8"));
  const reviewNotes = await readFile(result.reviewNotesPath, "utf8");

  assert.equal(reviewSummary.source.containerName, "trailarr");
  assert.match(reviewNotes, /Import Review/);
});
