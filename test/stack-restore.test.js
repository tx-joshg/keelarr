import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { restoreArchivedStack, writeStacks } from "../src/lib/generator.js";
import { normalizeSettings } from "../src/lib/store.js";

/**
 * The real compose file Keelarr wrote when it imported Radarr from a running
 * container. Reproduced verbatim because its exact shape is the point: the
 * config lives in an external named volume, which no catalog template would
 * ever produce.
 */
const IMPORTED_COMPOSE = `name: radarr
services:
  radarr:
    container_name: radarr
    image: linuxserver/radarr:latest
    restart: unless-stopped
    volumes:
      - /share/Media:/Media
      - radarr_config:/config
    network_mode: host
volumes:
  radarr_config:
    external: true
    name: 7af34389e6dfa294216b95968dd5f37712e7c75bd83ad7c64ecd84b2c35491f6
`;

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), "keelarr-restore-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const settings = normalizeSettings({
    initialized: true,
    stackRoot: path.join(root, "stacks"),
    configRoot: path.join(root, "config"),
    mediaRoot: path.join(root, "media"),
    downloadsRoot: path.join(root, "media/downloads"),
    selectedServiceIds: ["radarr"]
  });

  const archive = path.join(root, "backups", "radarr", "2026-08-10T00-00-00Z");
  await mkdir(archive, { recursive: true });
  await writeFile(path.join(archive, "compose.yml"), IMPORTED_COMPOSE, "utf8");

  return { root, settings, archive };
}

function asImported(settings, archive) {
  return normalizeSettings({
    ...settings,
    serviceOverrides: {
      radarr: { mode: "imported", containerName: "radarr", restoreFrom: archive }
    }
  });
}

test("an imported service reinstalls with its original compose, not a catalog one", async (t) => {
  const { settings, archive } = await workspace(t);
  const restored = asImported(settings, archive);

  await writeStacks(restored, ["radarr"]);
  const written = await readFile(restored.services.radarr.composePath, "utf8");

  // The named volume is the whole point: regenerating from the catalog would
  // bind-mount a path that has never existed and the app would start empty.
  assert.match(written, /radarr_config:\/config/);
  assert.match(written, /external: true/);
  assert.match(written, /network_mode: host/);
  assert.ok(!written.includes("CONFIG_DIR"), "a catalog template leaked in");
});

test("restoring never overwrites a stack that is already in place", async (t) => {
  const { settings, archive } = await workspace(t);
  const restored = asImported(settings, archive);
  const service = restored.services.radarr;

  await mkdir(service.stackDir, { recursive: true });
  await writeFile(service.composePath, "name: edited-by-hand\n", "utf8");

  const result = await restoreArchivedStack(service);

  assert.equal(result, null);
  assert.equal(await readFile(service.composePath, "utf8"), "name: edited-by-hand\n");
});

test("a service with no archive is left alone rather than half-restored", async (t) => {
  const { settings } = await workspace(t);

  assert.equal(await restoreArchivedStack(settings.services.radarr), null);
});

test("an archive that lost its compose file is not treated as a restore", async (t) => {
  const { settings, root } = await workspace(t);
  const empty = path.join(root, "backups", "radarr", "empty");
  await mkdir(empty, { recursive: true });

  const restored = asImported(settings, empty);

  // Reinstalling should fail loudly rather than deploy something invented.
  await assert.rejects(() => writeStacks(restored, ["radarr"]), /Imported draft files are missing/);
});

test("a catalog service still regenerates from the catalog", async (t) => {
  const { settings } = await workspace(t);

  await writeStacks(settings, ["radarr"]);
  const written = await readFile(settings.services.radarr.composePath, "utf8");

  assert.match(written, /\$\{CONFIG_DIR\}/);
  // The shared network is legitimately external here; what must not appear is
  // an external *volume*, which is the imported shape.
  assert.ok(!written.includes("radarr_config"), "an imported volume leaked into a catalog stack");
});
