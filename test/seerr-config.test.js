import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { prepareConfigDir, writeStacks } from "../src/lib/generator.js";
import { buildImportPreview } from "../src/lib/import-planner.js";
import { buildAdoptionIssues, matchSupportedService } from "../src/lib/import-scanner.js";
import { readConfigMountSource } from "../src/lib/runtimes/docker-runtime.js";
import { configMountTarget } from "../src/lib/service-catalog.js";
import { normalizeSettings } from "../src/lib/store.js";

async function tempRoot(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "keelarr-seerr-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function settingsAt(root, extra = {}) {
  return normalizeSettings({
    initialized: true,
    stackRoot: path.join(root, "stacks"),
    configRoot: path.join(root, "config"),
    mediaRoot: path.join(root, "media"),
    downloadsRoot: path.join(root, "downloads"),
    selectedServiceIds: ["seerr", "radarr"],
    ...extra
  });
}

test("Seerr's config target is /app/config and everything else stays /config", () => {
  assert.equal(configMountTarget("seerr"), "/app/config");
  assert.equal(configMountTarget("radarr"), "/config");
  assert.equal(configMountTarget("not-a-service"), "/config");
});

test("generating Seerr creates its config directory and hands it to the stack identity", async (t) => {
  const root = await tempRoot(t);
  const settings = settingsAt(root);
  const chowned = [];

  const writes = await writeStacks(settings, ["seerr"], {
    chownImpl: async (target, uid, gid) => chowned.push([target, uid, gid])
  });

  const seerr = settings.services.seerr;
  assert.equal(writes[0].configDir.created, true);
  assert.equal(writes[0].configDir.owned, true);
  assert.deepEqual(chowned, [[seerr.configDir, Number(settings.puid), Number(settings.pgid)]]);
  assert.match(await readFile(seerr.composePath, "utf8"), /:\/app\/config/);
});

test("apps that fix their own ownership get no config directory made for them", async (t) => {
  const root = await tempRoot(t);
  const settings = settingsAt(root);
  let called = false;

  const writes = await writeStacks(settings, ["radarr"], { chownImpl: async () => { called = true; } });

  assert.equal(called, false);
  assert.equal(writes[0].configDir, undefined);
});

test("an existing Seerr config directory with data in it is never re-owned", async (t) => {
  const root = await tempRoot(t);
  const settings = settingsAt(root);
  const service = settings.services.seerr;
  await mkdir(service.configDir, { recursive: true });
  await writeFile(path.join(service.configDir, "settings.json"), "{}");
  let called = false;

  const result = await prepareConfigDir(settings, service, { chownImpl: async () => { called = true; } });

  assert.equal(called, false);
  assert.deepEqual(result, { path: service.configDir, created: false, owned: false });
});

test("an empty Seerr config directory left behind by Docker is taken over", async (t) => {
  const root = await tempRoot(t);
  const settings = settingsAt(root);
  const service = settings.services.seerr;
  await mkdir(service.configDir, { recursive: true });
  const chowned = [];

  const result = await prepareConfigDir(settings, service, { chownImpl: async (...args) => chowned.push(args) });

  assert.equal(result.owned, true);
  assert.equal(chowned.length, 1);
});

test("a chown that fails is reported with the fix, not thrown", async (t) => {
  const root = await tempRoot(t);
  const settings = settingsAt(root);
  const service = settings.services.seerr;

  const result = await prepareConfigDir(settings, service, {
    chownImpl: async () => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    }
  });

  assert.equal(result.owned, false);
  assert.match(result.warning, /chown \d+:\d+ /);
  assert.match(result.warning, /EPERM/);
});

const seerrInspect = {
  Config: { Image: "fallenbagel/jellyseerr:latest" },
  HostConfig: { NetworkMode: "bridge" }
};

test("adoption accepts a Seerr mounted at /app/config", async (t) => {
  const root = await tempRoot(t);
  const source = path.join(root, "seerr-config");
  await mkdir(source);
  const match = matchSupportedService({ ...seerrInspect, Name: "/jellyseerr" });

  assert.equal(match?.serviceId, "seerr");
  const issues = await buildAdoptionIssues(match, seerrInspect, [{ type: "bind", source, target: "/app/config" }]);
  assert.equal(issues.some((issue) => issue.level === "error"), false, JSON.stringify(issues));
});

test("adoption flags a Seerr that only has /config mounted", async (t) => {
  const root = await tempRoot(t);
  const source = path.join(root, "seerr-config");
  await mkdir(source);
  const match = matchSupportedService({ ...seerrInspect, Name: "/jellyseerr" });

  const issues = await buildAdoptionIssues(match, seerrInspect, [{ type: "bind", source, target: "/config" }]);
  assert.ok(issues.some((issue) => issue.level === "error" && issue.message.includes("/app/config")));
});

test("the import preview preserves Seerr's /app/config mount", async (t) => {
  const root = await tempRoot(t);
  const settings = settingsAt(root);

  const preview = await buildImportPreview(settings, {
    containerId: "seerrdemo",
    containerName: "jellyseerr",
    image: "fallenbagel/jellyseerr:latest",
    recognized: true,
    serviceId: "seerr",
    serviceName: "Seerr",
    matchedBy: "image",
    status: "running",
    restartPolicy: "unless-stopped",
    networkMode: "bridge",
    ports: [{ hostPort: "5055", containerPort: "5055" }],
    mounts: [{ type: "bind", source: "/srv/jellyseerr", target: "/app/config" }],
    networks: [],
    envKeys: ["TZ"],
    issues: [],
    adoptable: true
  });

  const config = preview.preservation.find((item) => item.label === "Config");
  assert.equal(config.target, "/app/config");
  assert.equal(config.source, "/srv/jellyseerr");
  assert.notEqual(config.status, "missing");
});

test("config snapshots look for Seerr's mount at /app/config", async (t) => {
  const root = await tempRoot(t);
  const argsFile = path.join(root, "args");
  const stub = path.join(root, "docker");
  await writeFile(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nprintf 'bind|/srv/jellyseerr'\n`);
  await chmod(stub, 0o755);

  const mount = await readConfigMountSource({ dockerBin: stub }, { id: "seerr", containerName: "seerr" });

  assert.deepEqual(mount, { type: "bind", source: "/srv/jellyseerr" });
  assert.match(await readFile(argsFile, "utf8"), /Destination "\/app\/config"/);
});
