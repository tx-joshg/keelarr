import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";

import { WiringService } from "../src/lib/app-services/wiring-service.js";
import { JOB_STATUS, JobRegistry } from "../src/lib/jobs.js";
import { createLogger } from "../src/lib/logger.js";
import { normalizeSettings } from "../src/lib/store.js";
import { parseSeerrApiKey, readApiKey } from "../src/lib/wiring/api-keys.js";
import { RECONCILE_STATE, reconcileSeerrServer } from "../src/lib/wiring/reconcile.js";
import { buildSeerrServerPayload, buildSeerrTestPayload } from "../src/lib/wiring/payloads.js";
import { findMissingPrerequisites } from "../src/lib/wiring/prerequisites.js";
import { buildComposeSpec, buildServiceFromCatalog } from "../src/lib/service-catalog.js";
import { buildEnvEntries } from "../src/lib/generator.js";
import { matchSupportedService } from "../src/lib/import-scanner.js";

const noop = () => {};
const silentLogger = createLogger({
  level: "error",
  filePath: path.join(tmpdir(), "keelarr-test.log"),
  consoleImpl: { debug: noop, info: noop, warn: noop, error: noop, log: noop }
});

/**
 * Seerr's key is base64 of a timestamp and a UUID — deliberately not the
 * 32-hex shape every other app in the catalog uses, because a parser written
 * for those finds nothing in this.
 */
const SEERR_KEY = "MTc2MDAwMDAwMDAwMGE0ZTNmYzEtNGE5Yi00ZjAwLTljMWEtYmIyMmNjMzM0NDU1";
const RADARR_KEY = "0123456789abcdef0123456789abcdef";
const LONG_AGO = "2026-08-01T00:00:00.000Z";

/** The real shape: Seerr stores the keys of the apps it talks to in the same file. */
const SETTINGS_JSON = JSON.stringify({
  clientId: "e6b7f1a0",
  main: { apiKey: SEERR_KEY, applicationTitle: "Seerr", localLogin: true },
  radarr: [{ id: 0, name: "Radarr", hostname: "radarr", port: 7878, apiKey: RADARR_KEY }],
  sonarr: []
});

// --- the API key ---

test("Seerr's base64 key is read, where a hex-shaped parser would find nothing", () => {
  assert.equal(parseSeerrApiKey(SETTINGS_JSON), SEERR_KEY);
});

test("Seerr's own key is read, not the Radarr key stored beside it", () => {
  // `radarr[0].apiKey` is in the same document. Scoped to `main` for the same
  // reason Bazarr's read is scoped to its auth block.
  assert.notEqual(parseSeerrApiKey(SETTINGS_JSON), RADARR_KEY);
});

test("a half-written settings file reads as pending rather than throwing", () => {
  // Seerr truncates this file in place when it saves, so catching a partial
  // document mid-write is a normal state that resolves on the next read.
  assert.equal(parseSeerrApiKey('{"main": {"apiKey": "abc'), null);
  assert.equal(parseSeerrApiKey(""), null);
  assert.equal(parseSeerrApiKey(null), null);
});

test("a settings file with no key yet yields nothing rather than an empty string", () => {
  assert.equal(parseSeerrApiKey(JSON.stringify({ main: { apiKey: "" } })), null);
  assert.equal(parseSeerrApiKey(JSON.stringify({ main: {} })), null);
});

test("Seerr is read from /app/config, which is not where the rest of the stack keeps config", async () => {
  const paths = [];
  const result = await readApiKey(
    { dockerBin: "docker" },
    { id: "seerr", name: "Seerr", containerName: "seerr" },
    {
      readContainerFileImpl: async (_s, _c, p) => {
        paths.push(p);
        return p === "/app/config/settings.json" ? SETTINGS_JSON : null;
      }
    }
  );

  assert.deepEqual(paths, ["/app/config/settings.json"]);
  assert.equal(result.key, SEERR_KEY);
  // The descriptor is the only part that goes on the wire.
  assert.ok(!JSON.stringify(result.descriptor).includes(SEERR_KEY));
});

// --- the compose file ---

const SETTINGS = normalizeSettings({
  initialized: true,
  hostUrl: "http://198.51.100.2",
  stackRoot: "/share/Container/docker",
  configRoot: "/share/Container",
  mediaRoot: "/share/Media",
  puid: "911",
  pgid: "911",
  selectedServiceIds: ["seerr"]
});

test("Seerr's config is mounted at /app/config, the path it actually writes to", () => {
  const spec = buildComposeSpec(SETTINGS, buildServiceFromCatalog(SETTINGS, "seerr"));

  // Mounting /config instead is the single most common way to install Seerr
  // wrong: it starts, works, and loses everything on the next restart.
  assert.ok(spec.services.seerr.volumes.includes("${CONFIG_DIR}:/app/config"));
  assert.ok(!spec.services.seerr.volumes.some((entry) => entry.endsWith(":/config")));
});

test("Seerr runs as the stack's identity even though its image ignores PUID", () => {
  const spec = buildComposeSpec(SETTINGS, buildServiceFromCatalog(SETTINGS, "seerr"));

  // The image runs as its own node user (UID 1000) and has no PUID support, so
  // `user:` is the only lever. Left alone, its config directory would be the one
  // directory under configRoot the rest of the stack could not read.
  assert.equal(spec.services.seerr.user, "${PUID}:${PGID}");
  assert.equal(spec.services.seerr.environment.PUID, undefined);
});

test("identity keys reach .env for a service whose image never reads them", () => {
  const entries = new Map(buildEnvEntries(SETTINGS, buildServiceFromCatalog(SETTINGS, "seerr")));

  // Without these, `user:` renders as a bare colon and the container will not
  // start — so the keys are load-bearing even though the image ignores them.
  assert.equal(entries.get("PUID"), "911");
  assert.equal(entries.get("PGID"), "911");
});

test("FlareSolverr still gets no identity keys, because it owns nothing", () => {
  const settings = normalizeSettings({ ...SETTINGS, selectedServiceIds: ["flaresolverr"] });
  const entries = new Map(buildEnvEntries(settings, buildServiceFromCatalog(settings, "flaresolverr")));

  assert.equal(entries.has("PUID"), false);
});

test("Seerr binds the container side of the port mapping, not whatever .env says", () => {
  const spec = buildComposeSpec(SETTINGS, buildServiceFromCatalog(SETTINGS, "seerr"));

  // An edited host port must not move the listener away from the port the
  // mapping still targets — the trap qBittorrent's WEBUI_PORT also avoids.
  assert.equal(spec.services.seerr.environment.PORT, "5055");
  assert.ok(spec.services.seerr.ports.includes("${PORT}:5055"));
});

// --- adoption ---

test("a container still running the old Jellyseerr image is recognised, not reported unsupported", () => {
  const match = matchSupportedService({
    Name: "/requests",
    Config: { Image: "fallenbagel/jellyseerr:latest" }
  });

  assert.equal(match?.serviceId, "seerr");
  assert.equal(match.matchedBy, "image");
});

test("the Overseerr image Seerr was forked from is recognised too", () => {
  const match = matchSupportedService({
    Name: "/overseerr",
    Config: { Image: "sctx/overseerr" }
  });

  assert.equal(match?.serviceId, "seerr");
});

test("the current image is recognised through its registry prefix", () => {
  const match = matchSupportedService({
    Name: "/requests",
    Config: { Image: "ghcr.io/seerr-team/seerr:2.5.0" }
  });

  assert.equal(match?.serviceId, "seerr");
});

// --- reconciling a server entry ---

const server = (overrides = {}) => ({
  id: 0,
  name: "Radarr",
  hostname: "radarr",
  port: 7878,
  is4k: false,
  isDefault: true,
  ...overrides
});

test("a server pointing at the right place is correct", () => {
  const result = reconcileSeerrServer([server()], { appName: "Radarr", hostname: "radarr", port: 7878 });

  assert.equal(result.state, RECONCILE_STATE.CORRECT);
});

test("a renamed server is still matched, because the name is not its identity", () => {
  const result = reconcileSeerrServer(
    [server({ name: "Movies (1080p)" })],
    { appName: "Radarr", hostname: "radarr", port: 7878 }
  );

  assert.equal(result.state, RECONCILE_STATE.CORRECT);
});

test("one server pointing elsewhere is drift, and is never rewritten", () => {
  const result = reconcileSeerrServer(
    [server({ hostname: "192.168.1.50" })],
    { appName: "Radarr", hostname: "radarr", port: 7878 }
  );

  assert.equal(result.state, RECONCILE_STATE.DRIFT);
  assert.deepEqual(result.changes, [{ field: "hostname", from: "192.168.1.50", to: "radarr" }]);
});

test("two non-matching servers are ambiguous rather than guessed between", () => {
  const result = reconcileSeerrServer(
    [server({ id: 0, hostname: "old-host" }), server({ id: 1, hostname: "other-host" })],
    { appName: "Radarr", hostname: "radarr", port: 7878 }
  );

  assert.equal(result.state, RECONCILE_STATE.AMBIGUOUS);
  assert.equal(result.target, null);
});

test("a 4K server is not a candidate, so a correct 4K pair is not called drift", () => {
  // Seerr keeps 4K servers in the same array. They point at a different Radarr
  // on purpose, so comparing against one would try to rewrite a working setup.
  const result = reconcileSeerrServer(
    [server({ is4k: true, hostname: "radarr-4k" })],
    { appName: "Radarr", hostname: "radarr", port: 7878 }
  );

  assert.equal(result.state, RECONCILE_STATE.ABSENT);
});

// --- the payload ---

const TEST_RESULT = {
  profiles: [{ id: 4, name: "HD-1080p" }, { id: 1, name: "Any" }],
  rootFolders: [{ id: 1, path: "/Media/Movies" }, { id: 2, path: "/Media/Films" }],
  tags: []
};

test("a server payload takes its profile and folder from the test response", () => {
  const { payload, chosen } = buildSeerrServerPayload("radarr", {
    appName: "Radarr",
    hostname: "radarr",
    port: 7878,
    apiKey: RADARR_KEY,
    testResult: TEST_RESULT
  });

  // These two ids exist nowhere else: Seerr rejects a server without them, and
  // only its own test call reports them.
  assert.equal(payload.activeProfileId, 4);
  assert.equal(payload.activeProfileName, "HD-1080p");
  assert.equal(payload.activeDirectory, "/Media/Movies");
  assert.equal(chosen.profileName, "HD-1080p");
});

test("the folder the Arr app already uses wins over whichever came first", () => {
  const { payload } = buildSeerrServerPayload("radarr", {
    appName: "Radarr",
    hostname: "radarr",
    port: 7878,
    apiKey: RADARR_KEY,
    testResult: TEST_RESULT,
    preferredDirectory: "/Media/Films"
  });

  assert.equal(payload.activeDirectory, "/Media/Films");
});

test("a Radarr with no quality profile is reported as a chore, not written half-formed", () => {
  const { payload, missing } = buildSeerrServerPayload("radarr", {
    appName: "Radarr",
    hostname: "radarr",
    port: 7878,
    apiKey: RADARR_KEY,
    testResult: { profiles: [], rootFolders: TEST_RESULT.rootFolders }
  });

  assert.equal(payload, null);
  assert.match(missing, /no quality profile/);
});

test("a Radarr with no root folder is reported rather than guessed at", () => {
  const { payload, missing } = buildSeerrServerPayload("radarr", {
    appName: "Radarr",
    hostname: "radarr",
    port: 7878,
    apiKey: RADARR_KEY,
    testResult: { profiles: TEST_RESULT.profiles, rootFolders: [] }
  });

  assert.equal(payload, null);
  assert.match(missing, /nowhere to send/);
});

test("a default is claimed only when nothing else holds it", () => {
  const unclaimed = buildSeerrServerPayload("radarr", {
    appName: "Radarr", hostname: "radarr", port: 7878, apiKey: RADARR_KEY, testResult: TEST_RESULT
  });
  const taken = buildSeerrServerPayload("radarr", {
    appName: "Radarr",
    hostname: "radarr",
    port: 7878,
    apiKey: RADARR_KEY,
    testResult: TEST_RESULT,
    existingServers: [server({ hostname: "other", isDefault: true })]
  });

  assert.equal(unclaimed.payload.isDefault, true);
  // Seerr clears every other default when it accepts one, so asserting this
  // unconditionally would silently demote a server the operator chose.
  assert.equal(taken.payload.isDefault, false);
});

test("a Sonarr payload carries the series fields Radarr's does not", () => {
  const { payload } = buildSeerrServerPayload("sonarr", {
    appName: "Sonarr", hostname: "sonarr", port: 8989, apiKey: RADARR_KEY, testResult: TEST_RESULT
  });

  assert.equal(payload.seriesType, "standard");
  assert.equal(payload.enableSeasonFolders, true);
  assert.equal(payload.minimumAvailability, undefined);
});

test("an app Seerr cannot request from is refused rather than sent a Radarr body", () => {
  assert.throws(
    () => buildSeerrServerPayload("lidarr", { appName: "Lidarr", testResult: TEST_RESULT }),
    /not an app Seerr can be pointed at/
  );
});

test("a test payload carries the credential but none of the half-built server", () => {
  const body = buildSeerrTestPayload({ hostname: "radarr", port: 7878, apiKey: RADARR_KEY });

  assert.equal(body.apiKey, RADARR_KEY);
  // Nothing Seerr might store: a test must not be a partial create.
  assert.equal(body.activeProfileId, undefined);
  assert.equal(body.isDefault, undefined);
});

// --- the prerequisite ---

test("a Seerr nobody has set up reports the wizard rather than looking broken", () => {
  const missing = findMissingPrerequisites({
    apps: new Map([["seerr", { initialized: false }]]),
    services: [{ id: "seerr", name: "Seerr" }],
    appUrls: { seerr: "http://198.51.100.2:5055" }
  });

  assert.equal(missing.length, 1);
  assert.equal(missing[0].requirement, "first-run-setup");
  assert.match(missing[0].summary, /signed in to a media server/);
});

test("a Seerr whose state could not be read asks for nothing", () => {
  const missing = findMissingPrerequisites({
    apps: new Map([["seerr", { initialized: null }]]),
    services: [{ id: "seerr", name: "Seerr" }]
  });

  assert.deepEqual(missing, []);
});

// --- the job ---

const PORTS = { radarr: 7878, sonarr: 8989, seerr: 5055 };

function inspectFor(name, port, address) {
  return {
    Name: `/${name}`,
    State: { Running: true, StartedAt: LONG_AGO },
    HostConfig: { NetworkMode: "keelarr" },
    Config: { ExposedPorts: { [`${port}/tcp`]: {} } },
    NetworkSettings: { Networks: { keelarr: { IPAddress: address } }, Ports: {} },
    Mounts: [{ Source: "/share/Media", Destination: "/Media" }]
  };
}

function createHarness(overrides = {}) {
  const calls = [];
  const selected = overrides.selected || ["radarr", "seerr"];
  const settings = normalizeSettings({
    initialized: true,
    hostUrl: "http://198.51.100.2",
    mediaRoot: "/share/Media",
    selectedServiceIds: selected
  });

  const service = new WiringService({
    logger: silentLogger,
    jobs: new JobRegistry({ logger: silentLogger }),
    sleepImpl: async () => {},
    pathExistsImpl: async () => true,
    ensureLibraryFolderImpl: async () => ({ ok: true, created: false, hostPath: "/share/Media/Movies" }),
    loadSettingsImpl: async () => settings,
    appendActivityImpl: async () => {},
    inspectContainersImpl: async () => [
      ...selected.map((id, index) => inspectFor(id, PORTS[id], `172.30.0.${10 + index}`)),
      inspectFor("keelarr", 4687, "172.30.0.2")
    ],
    inspectNetworkDriversImpl: async () => new Map([["keelarr", "bridge"]]),
    readApiKeyImpl: async (_settings, target) => ({
      key: (overrides.unreadableKeys || []).includes(target.id)
        ? null
        : { seerr: SEERR_KEY, radarr: RADARR_KEY, sonarr: RADARR_KEY }[target.id] || null,
      descriptor: { found: true, state: "found", source: "x", fingerprint: "aabbccdd" },
      downloadSettings: null
    }),
    probeSeerrImpl: async () => overrides.probe || { reachable: true, initialized: true, error: null },
    seerrApiImpl: {
      listServers: async (_base, _key, kind) => {
        calls.push({ call: "list", kind });
        return overrides.listFails
          ? { ok: false, data: null, error: "Seerr rejected the API key." }
          : { ok: true, data: overrides.servers?.[kind] || [], error: null };
      },
      testServer: async (_base, _key, kind, body) => {
        calls.push({ call: "test", kind, body });
        return overrides.testResult || { ok: true, data: TEST_RESULT, error: null };
      },
      createServer: async (_base, _key, kind, body) => {
        calls.push({ call: "create", kind, body });
        return overrides.createResult || { ok: true, data: { ...body, id: 0 }, error: null };
      }
    },
    arrApiImpl: {
      systemStatus: async () => ({ ok: true, data: { version: "5.0" }, error: null }),
      listDownloadClients: async () => ({ ok: true, data: [], error: null }),
      listRootFolders: async () => ({ ok: true, data: [{ path: "/Media/Films" }], error: null }),
      listApplications: async () => ({ ok: true, data: [], error: null }),
      listIndexers: async () => ({ ok: true, data: [{ id: 1 }], error: null }),
      testAllDownloadClients: async () => ({ ok: true, data: [], error: null }),
      testAllApplications: async () => ({ ok: true, data: [], error: null })
    }
  });

  return { service, calls };
}

async function settle(job) {
  while (job.status === JOB_STATUS.PENDING || job.status === JOB_STATUS.RUNNING) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  return job;
}

const requestLinks = (report) => report.links.filter((link) => link.kind === "request-source");

test("an unwired Seerr is reported as needing one link per library app", async () => {
  const { service } = createHarness({ selected: ["radarr", "sonarr", "seerr"] });
  const report = await service.describeWiring();
  const links = requestLinks(report);

  assert.equal(links.length, 2);
  assert.deepEqual(links.map((link) => link.target).sort(), ["radarr", "sonarr"]);
  assert.ok(links.every((link) => link.state === RECONCILE_STATE.ABSENT));
});

test("an already-pointed Seerr proposes nothing", async () => {
  const { service } = createHarness({
    servers: { radarr: [server({ hostname: "radarr", port: 7878 })] }
  });
  const links = requestLinks(await service.describeWiring());

  assert.equal(links[0].state, RECONCILE_STATE.CORRECT);
});

test("a Seerr whose server list cannot be read is unknown, not unconfigured", async () => {
  // The dangerous direction: reporting absent here would make the apply job try
  // to write with a key Seerr had just refused.
  const { service } = createHarness({ listFails: true });
  const links = requestLinks(await service.describeWiring());

  assert.notEqual(links[0].state, RECONCILE_STATE.ABSENT);
});

test("an unfinished Seerr says so rather than blaming its API key", async () => {
  const { service } = createHarness({ probe: { reachable: true, initialized: false, error: null } });
  const links = requestLinks(await service.describeWiring());

  assert.match(links[0].reason, /has not been set up yet/);
});

test("applying tests before it writes, because the test is where the ids come from", async () => {
  const { service, calls } = createHarness();
  const job = await settle(service.startWiring());
  const ordered = calls.filter((entry) => entry.call === "test" || entry.call === "create");

  assert.equal(job.status, JOB_STATUS.SUCCEEDED);
  assert.deepEqual(ordered.map((entry) => entry.call), ["test", "create"]);
  assert.equal(ordered[1].body.activeProfileId, 4);
  // The folder Radarr itself reported, not whichever the test listed first.
  assert.equal(ordered[1].body.activeDirectory, "/Media/Films");
  assert.ok(job.result.created.includes("Seerr → Radarr"));
});

test("the quality profile Keelarr picked is stated rather than left to be discovered", async () => {
  const { service } = createHarness();
  const job = await settle(service.startWiring());

  // A profile is a taste decision. Keelarr made one; saying so is the price.
  assert.ok(job.result.notes.some((note) => /HD-1080p/.test(note) && /Change either in Seerr/.test(note)));
});

test("the real API key is sent, never anything Seerr handed back", async () => {
  const { service, calls } = createHarness();
  await settle(service.startWiring());

  assert.equal(calls.find((entry) => entry.call === "create").body.apiKey, RADARR_KEY);
});

test("a refused connection test is reported and nothing is written", async () => {
  const { service, calls } = createHarness({
    testResult: { ok: false, data: null, error: "Failed to connect to Radarr" }
  });
  const job = await settle(service.startWiring());

  assert.equal(calls.some((entry) => entry.call === "create"), false);
  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.match(job.error.message, /Failed to connect to Radarr/);
});

test("a 201 carrying no id is a failure, not a created link", async () => {
  // Seerr answering 201 while storing nothing is exactly the shape of claim
  // Keelarr is not allowed to repeat.
  const { service } = createHarness({ createResult: { ok: true, data: {}, error: null } });
  const job = await settle(service.startWiring());

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.match(job.error.message, /did not store it/);
});

test("an unreadable Radarr key fails that one link with a reason naming it", async () => {
  const { service, calls } = createHarness({ unreadableKeys: ["radarr"] });
  await settle(service.startWiring());

  assert.equal(calls.some((entry) => entry.call === "create"), false);
});

test("a stack without Seerr is never asked about requests", async () => {
  const { service, calls } = createHarness({ selected: ["radarr"] });
  const report = await service.describeWiring();

  assert.equal(requestLinks(report).length, 0);
  assert.equal(calls.some((entry) => entry.call === "list"), false);
});
