import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { normalizeSettings, writeJson } from "../src/lib/store.js";

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

test("writeJson replaces the target atomically and leaves no temp files behind", async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), "stackarr-store-"));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const target = path.join(workDir, "settings.json");

  await writeJson(target, { initialized: false });
  await writeJson(target, { initialized: true });

  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { initialized: true });
  assert.deepEqual(await readdir(workDir), ["settings.json"]);
});

test("writeJson does not clobber the existing file when serialization fails", async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), "stackarr-store-"));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const target = path.join(workDir, "settings.json");
  await writeJson(target, { initialized: true });

  const circular = {};
  circular.self = circular;
  await assert.rejects(() => writeJson(target, circular));

  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { initialized: true });
  assert.deepEqual(await readdir(workDir), ["settings.json"]);
});
