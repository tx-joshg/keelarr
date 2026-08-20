import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildServicesFromSelection, buildComposeSpec } from "../src/lib/service-catalog.js";
import {
  buildEnvEntries,
  renderEnvExampleText,
  renderEnvText,
  writeDraftFiles,
  writeStacks
} from "../src/lib/generator.js";
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

test("renders .env with resolved values and .env.example with keys only", () => {
  const settings = normalizeSettings({
    stackRoot: "/share/Container/docker",
    configRoot: "/share/Container",
    mediaRoot: "/share/Media",
    downloadsRoot: "/share/Media/Downloads",
    selectedServiceIds: ["radarr"]
  });
  const entries = buildEnvEntries(settings, settings.services.radarr);

  assert.match(renderEnvText(entries), /^MEDIA_DIR=\/share\/Media$/m);
  assert.match(renderEnvExampleText(entries), /^MEDIA_DIR=$/m);
  assert.doesNotMatch(renderEnvExampleText(entries), /\/share\/Media/);
});

test("writeStacks keeps host values out of the generated .env.example", async () => {
  const stackRoot = await mkdtemp(path.join(os.tmpdir(), "keelarr-env-"));
  const settings = normalizeSettings({
    stackRoot,
    configRoot: "/share/Container",
    mediaRoot: "/share/Media",
    downloadsRoot: "/share/Media/Downloads",
    selectedServiceIds: ["sabnzbd"]
  });

  await writeStacks(settings, ["sabnzbd"]);

  const envText = await readFile(settings.services.sabnzbd.envPath, "utf8");
  const envExampleText = await readFile(settings.services.sabnzbd.envExamplePath, "utf8");

  assert.match(envText, /^DOWNLOADS_DIR=\/share\/Media\/Downloads$/m);
  assert.match(envExampleText, /^DOWNLOADS_DIR=$/m);
  assert.doesNotMatch(envExampleText, /\/share\//);

  // Both files must still describe the same key set.
  const keysOf = (text) => text.trim().split("\n").map((line) => line.split("=")[0]);
  assert.deepEqual(keysOf(envExampleText), keysOf(envText));
});

test("writes import review artifacts beside a managed draft", async () => {
  const stackDir = await mkdtemp(path.join(os.tmpdir(), "keelarr-draft-"));
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

test("writeStacks preserves imported draft files instead of regenerating catalog defaults", async () => {
  const stackDir = await mkdtemp(path.join(os.tmpdir(), "keelarr-imported-stack-"));
  const composePath = path.join(stackDir, "compose.yml");
  const envPath = path.join(stackDir, ".env");
  const envExamplePath = path.join(stackDir, ".env.example");
  const reviewSummaryPath = path.join(stackDir, "import-summary.json");
  const reviewNotesPath = path.join(stackDir, "IMPORT-REVIEW.md");

  await writeDraftFiles({
    serviceId: "trailarr",
    stackDir,
    composePath,
    envPath,
    envExamplePath,
    composeYaml: "name: trailarr\nservices:\n  trailarr:\n    image: nandyalu/trailarr:custom\n",
    envText: "PUID=1000\n",
    envExampleText: "PUID=\n",
    reviewSummary: { source: { containerName: "trailarr" } },
    reviewNotes: "# Import Review\n"
  });

  const settings = normalizeSettings({
    stackRoot: path.dirname(stackDir),
    configRoot: "/share/Container",
    mediaRoot: "/share/Media",
    downloadsRoot: "/share/Media/Downloads",
    selectedServiceIds: ["trailarr"],
    serviceOverrides: {
      trailarr: {
        mode: "imported-draft",
        image: "nandyalu/trailarr:custom",
        port: 7889,
        containerName: "trailarr",
        restartPolicy: "unless-stopped",
        networkMode: "bridge",
        reviewSummaryPath,
        reviewNotesPath
      }
    }
  });

  settings.services.trailarr.stackDir = stackDir;
  settings.services.trailarr.composePath = composePath;
  settings.services.trailarr.envPath = envPath;
  settings.services.trailarr.envExamplePath = envExamplePath;
  settings.services.trailarr.reviewSummaryPath = reviewSummaryPath;
  settings.services.trailarr.reviewNotesPath = reviewNotesPath;

  const result = await writeStacks(settings, ["trailarr"]);
  const composeText = await readFile(composePath, "utf8");

  assert.equal(result[0].reviewSummaryPath, reviewSummaryPath);
  assert.match(composeText, /trailarr:custom/);
  assert.doesNotMatch(composeText, /trailarr:latest/);
});

test("writeStacks preserves files for a service that has already been cut over", async () => {
  const stackDir = await mkdtemp(path.join(os.tmpdir(), "keelarr-cutover-stack-"));
  const composePath = path.join(stackDir, "compose.yml");
  const envPath = path.join(stackDir, ".env");
  const envExamplePath = path.join(stackDir, ".env.example");

  await writeDraftFiles({
    serviceId: "trailarr",
    stackDir,
    composePath,
    envPath,
    envExamplePath,
    composeYaml: "name: trailarr\nservices:\n  trailarr:\n    image: nandyalu/trailarr:custom\n",
    envText: "PUID=1000\n",
    envExampleText: "PUID=\n"
  });

  const settings = normalizeSettings({
    stackRoot: path.dirname(stackDir),
    selectedServiceIds: ["trailarr"],
    serviceOverrides: {
      trailarr: {
        mode: "imported",
        image: "nandyalu/trailarr:custom",
        port: 7889,
        containerName: "trailarr"
      }
    }
  });

  settings.services.trailarr.stackDir = stackDir;
  settings.services.trailarr.composePath = composePath;
  settings.services.trailarr.envPath = envPath;
  settings.services.trailarr.envExamplePath = envExamplePath;

  await writeStacks(settings, ["trailarr"]);
  const composeText = await readFile(composePath, "utf8");

  // Regenerating catalog defaults here would silently revert a live service
  // to the stock image and mounts.
  assert.match(composeText, /trailarr:custom/);
  assert.doesNotMatch(composeText, /trailarr:latest/);
});

test("catalog stacks join one shared network so the apps can reach each other", async () => {
  const settings = normalizeSettings({
    stackRoot: "/share/Container/docker",
    configRoot: "/share/Container",
    mediaRoot: "/share/Media",
    downloadsRoot: "/share/Media/Downloads",
    selectedServiceIds: ["prowlarr", "radarr"]
  });

  for (const id of ["prowlarr", "radarr"]) {
    const spec = buildComposeSpec(settings, settings.services[id]);
    assert.deepEqual(spec.services[id].networks, ["keelarr"]);
    // External so no single stack owns it and `compose down` cannot take the
    // network away from the others.
    assert.deepEqual(spec.networks, { keelarr: { external: true, name: "keelarr" } });
  }
});

test("an imported stack is given this host's identity while the rest of it stays as adopted", async () => {
  const stackDir = await mkdtemp(path.join(os.tmpdir(), "keelarr-identity-stack-"));
  const composePath = path.join(stackDir, "compose.yml");
  const envPath = path.join(stackDir, ".env");
  const envExamplePath = path.join(stackDir, ".env.example");
  const reviewSummaryPath = path.join(stackDir, "import-summary.json");
  const reviewNotesPath = path.join(stackDir, "IMPORT-REVIEW.md");

  // Exactly the shape a real adoption produces for Trailarr: the image states
  // PUID itself, so the adopted container carried no PUID env of its own and
  // the draft records only TZ.
  await writeDraftFiles({
    serviceId: "trailarr",
    stackDir,
    composePath,
    envPath,
    envExamplePath,
    composeYaml: [
      "name: trailarr",
      "services:",
      "  trailarr:",
      "    container_name: trailarr",
      "    image: nandyalu/trailarr:latest",
      "    environment:",
      "      TZ: ${TZ}",
      "    entrypoint:",
      "      - /app/scripts/entrypoint.sh",
      ""
    ].join("\n"),
    envText: "TZ=America/Chicago\n",
    envExampleText: "TZ=\n",
    reviewSummary: { source: { containerName: "trailarr" } },
    reviewNotes: "# Import Review\n"
  });

  const settings = normalizeSettings({
    stackRoot: path.dirname(stackDir),
    configRoot: "/share/Container",
    mediaRoot: "/share/Media",
    downloadsRoot: "/share/Media/Downloads",
    puid: "911",
    pgid: "911",
    selectedServiceIds: ["trailarr"],
    serviceOverrides: {
      trailarr: {
        mode: "imported-draft",
        image: "nandyalu/trailarr:latest",
        port: 7889,
        containerName: "trailarr",
        restartPolicy: "unless-stopped",
        networkMode: "bridge",
        reviewSummaryPath,
        reviewNotesPath
      }
    }
  });

  settings.services.trailarr.stackDir = stackDir;
  settings.services.trailarr.composePath = composePath;
  settings.services.trailarr.envPath = envPath;
  settings.services.trailarr.envExamplePath = envExamplePath;
  settings.services.trailarr.reviewSummaryPath = reviewSummaryPath;
  settings.services.trailarr.reviewNotesPath = reviewNotesPath;

  const result = await writeStacks(settings, ["trailarr"]);
  const composeText = await readFile(composePath, "utf8");
  const envText = await readFile(envPath, "utf8");

  assert.equal(result[0].identity.puid, "911");
  assert.match(composeText, /PUID: \$\{PUID\}/);
  assert.match(composeText, /PGID: \$\{PGID\}/);
  assert.match(envText, /^PUID=911$/m);
  assert.match(envText, /^PGID=911$/m);

  // Everything the adoption captured survives untouched.
  assert.match(composeText, /entrypoint/);
  assert.match(composeText, /nandyalu\/trailarr:latest/);
  assert.match(envText, /^TZ=America\/Chicago$/m);
});

test("a service that runs as its own user is not given a PUID it cannot honour", () => {
  const settings = normalizeSettings({
    stackRoot: "/share/Container/docker",
    configRoot: "/share/Container",
    mediaRoot: "/share/Media",
    downloadsRoot: "/share/Media/Downloads",
    selectedServiceIds: ["flaresolverr", "radarr"]
  });

  const services = buildServicesFromSelection(settings, ["flaresolverr", "radarr"]);
  const flaresolverr = buildEnvEntries(settings, services.flaresolverr).map(([key]) => key);
  const radarr = buildEnvEntries(settings, services.radarr).map(([key]) => key);

  assert.ok(!flaresolverr.includes("PUID"));
  assert.ok(!flaresolverr.includes("PGID"));
  assert.ok(radarr.includes("PUID"));
});
