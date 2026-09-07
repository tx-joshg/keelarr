import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { normalizeSettings, sanitizeBackupRetention, sanitizeClockTime, writeJson } from "../src/lib/store.js";

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
  const workDir = await mkdtemp(path.join(tmpdir(), "keelarr-store-"));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const target = path.join(workDir, "settings.json");

  await writeJson(target, { initialized: false });
  await writeJson(target, { initialized: true });

  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { initialized: true });
  assert.deepEqual(await readdir(workDir), ["settings.json"]);
});

test("writeJson does not clobber the existing file when serialization fails", async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), "keelarr-store-"));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const target = path.join(workDir, "settings.json");
  await writeJson(target, { initialized: true });

  const circular = {};
  circular.self = circular;
  await assert.rejects(() => writeJson(target, circular));

  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { initialized: true });
  assert.deepEqual(await readdir(workDir), ["settings.json"]);
});

test("backup retention defaults to keeping only the latest", () => {
  assert.equal(normalizeSettings({}).backupRetention, 1);
});

test("backup retention treats non-positive values as keep-all, not keep-none", () => {
  // Keeping zero backups would silently remove the ability to roll back, so an
  // out-of-range value resolves to the safe reading.
  assert.equal(sanitizeBackupRetention(0), 0);
  assert.equal(sanitizeBackupRetention(-5), 0);
  assert.equal(sanitizeBackupRetention("3"), 3);
  assert.equal(sanitizeBackupRetention(2.7), 2);
  assert.equal(sanitizeBackupRetention("nonsense"), 1);
  assert.equal(sanitizeBackupRetention(undefined), 1);
  // Bounded so a typo cannot request thousands of snapshots.
  assert.equal(sanitizeBackupRetention(9999), 50);
});

test("a stored selection naming a retired service is dropped, not carried forward", () => {
  // Readarr was removed from the catalog. Keeping the id would build no
  // service object for it, and the dashboard would read properties off
  // undefined on the next load.
  const settings = normalizeSettings({ selectedServiceIds: ["radarr", "readarr", "sonarr"] });

  assert.deepEqual(settings.selectedServiceIds, ["radarr", "sonarr"]);
  assert.equal(settings.services.readarr, undefined);
  assert.ok(settings.services.radarr);
});

test("removing the last service leaves an empty stack rather than reselecting defaults", () => {
  // The default selection exists for a first run. Applying it after setup turns
  // "I just removed my last app" into eight apps reappearing unasked.
  const settings = normalizeSettings({ initialized: true, selectedServiceIds: [] });

  assert.deepEqual(settings.selectedServiceIds, []);
  assert.deepEqual(settings.services, {});
});

test("a stack that has never been set up still gets the default selection", () => {
  const settings = normalizeSettings({ selectedServiceIds: [] });

  assert.ok(settings.selectedServiceIds.length > 0);
});

test("auto-revert is off by default and is a strict boolean", () => {
  // Off keeps today's behaviour, so an existing settings.json with no key
  // changes nothing. And a string "true" from a hand-edit must not read as on.
  assert.equal(normalizeSettings({}).autoRevert, false);
  assert.equal(normalizeSettings({ autoRevert: true }).autoRevert, true);
  assert.equal(normalizeSettings({ autoRevert: "true" }).autoRevert, false);
  assert.equal(normalizeSettings({ autoRevert: 1 }).autoRevert, false);
});

test("scheduled installs are off by default, at 03:00, and both switches are strict booleans", () => {
  const defaults = normalizeSettings({});
  assert.equal(defaults.autoUpdateEnabled, false);
  assert.equal(defaults.autoUpdateTime, "03:00");
  assert.equal(normalizeSettings({ autoUpdateEnabled: true }).autoUpdateEnabled, true);
  // A hand-edited "true" must not read as on.
  assert.equal(normalizeSettings({ autoUpdateEnabled: "true" }).autoUpdateEnabled, false);
  assert.equal(normalizeSettings({ autoUpdateEnabled: 1 }).autoUpdateEnabled, false);
});

test("the install window is a 24-hour clock time, and nonsense falls back to the default", () => {
  assert.equal(sanitizeClockTime("3:05"), "03:05");
  assert.equal(sanitizeClockTime("23:59"), "23:59");
  for (const bad of ["24:00", "3pm", "", undefined, 7, "03:60"]) {
    assert.equal(sanitizeClockTime(bad), "03:00", `${JSON.stringify(bad)} should fall back`);
  }
  assert.equal(normalizeSettings({ autoUpdateTime: "4:30" }).autoUpdateTime, "04:30");
});

test("a per-app auto-update opt-in survives a settings round-trip", () => {
  // sanitizeServiceOverrides is an allow-list: a key left off it is dropped on
  // the next save. This is the test that notices.
  const settings = normalizeSettings({
    initialized: true,
    selectedServiceIds: ["radarr", "sonarr"],
    serviceOverrides: { radarr: { autoUpdate: true }, sonarr: {} }
  });

  assert.equal(settings.serviceOverrides.radarr.autoUpdate, true);
  assert.equal(settings.services.radarr.autoUpdate, true);
  assert.equal(settings.services.sonarr.autoUpdate, false);
  // And it is strict too.
  assert.equal(normalizeSettings({ serviceOverrides: { radarr: { autoUpdate: "true" } } }).serviceOverrides.radarr.autoUpdate, false);
});
