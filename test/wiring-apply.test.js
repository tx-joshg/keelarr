import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";

import { WiringService } from "../src/lib/app-services/wiring-service.js";
import { JOB_STATUS, JobRegistry, STEP_STATUS } from "../src/lib/jobs.js";
import { createLogger } from "../src/lib/logger.js";
import { normalizeSettings } from "../src/lib/store.js";
import { MASKED_VALUE, buildApplicationPayload, buildDownloadClientPayload } from "../src/lib/wiring/payloads.js";

const noop = () => {};
const silentLogger = createLogger({
  level: "error",
  filePath: path.join(tmpdir(), "stackarr-test.log"),
  consoleImpl: { debug: noop, info: noop, warn: noop, error: noop, log: noop }
});

const SAB_KEY = "fedcba9876543210fedcba9876543210";
const RADARR_KEY = "0123456789abcdef0123456789abcdef";
const PROWLARR_KEY = "abcdef0123456789abcdef0123456789";
const LONG_AGO = "2026-08-01T00:00:00.000Z";

const DOWNLOAD_SCHEMA = [
  {
    implementation: "Sabnzbd",
    configContract: "SabnzbdSettings",
    protocol: "usenet",
    fields: [
      { name: "host", value: "localhost" },
      { name: "port", value: 8080 },
      { name: "useSsl", value: false },
      { name: "apiKey", privacy: "apiKey" },
      { name: "movieCategory", value: "movies" }
    ]
  },
  { implementation: "Transmission", fields: [] }
];

const APPLICATION_SCHEMA = [
  {
    implementation: "Radarr",
    configContract: "RadarrSettings",
    syncLevel: "fullSync",
    fields: [
      { name: "prowlarrUrl", value: "http://localhost:9696" },
      { name: "baseUrl", value: "http://localhost:7878" },
      { name: "apiKey", privacy: "apiKey" },
      { name: "syncCategories", value: [2000, 2010] }
    ]
  }
];

function inspectFor(name, port, { networkMode = "stackarr", address = "172.30.0.5", ports = {} } = {}) {
  return {
    Name: `/${name}`,
    State: { Running: true, StartedAt: LONG_AGO },
    HostConfig: { NetworkMode: networkMode },
    Config: { ExposedPorts: { [`${port}/tcp`]: {} } },
    NetworkSettings: { Networks: { [networkMode]: { IPAddress: address } }, Ports: ports },
    Mounts: [{ Source: "/share/Media", Destination: "/Media" }]
  };
}

const DRIVERS = new Map([["stackarr", "bridge"]]);

function createHarness(overrides = {}) {
  const calls = [];
  const activity = [];
  const settings = normalizeSettings({
    initialized: true,
    hostUrl: "http://198.51.100.2",
    mediaRoot: "/share/Media",
    selectedServiceIds: overrides.selected || ["radarr", "sabnzbd", "prowlarr"]
  });

  const service = new WiringService({
    logger: silentLogger,
    jobs: new JobRegistry({ logger: silentLogger }),
    appendActivityImpl: async (entry) => activity.push(entry),
    loadSettingsImpl: async () => settings,
    inspectContainersImpl: async () => [
      inspectFor("radarr", 7878),
      inspectFor("sabnzbd", 8080, { address: "172.30.0.6" }),
      inspectFor("prowlarr", 9696, { address: "172.30.0.7" }),
      inspectFor("stackarr", 4687, { address: "172.30.0.2" })
    ],
    inspectNetworkDriversImpl: async () => DRIVERS,
    readApiKeyImpl: async (_settings, target) => ({
      key: { sabnzbd: SAB_KEY, radarr: RADARR_KEY, prowlarr: PROWLARR_KEY }[target.id] || null,
      descriptor: { found: true, state: "found", source: "/config/config.xml", fingerprint: "aabbccdd" },
      downloadSettings:
        target.id === "sabnzbd" ? { completeDir: "/Media/Downloads/complete", hostWhitelist: [] } : null
    }),
    arrApiImpl: {
      systemStatus: async () => ({ ok: true, data: { version: "1.0" }, error: null }),
      listDownloadClients: async () => ({ ok: true, data: overrides.downloadClients ?? [], error: null }),
      listRootFolders: async () => ({ ok: true, data: overrides.rootFolders ?? [{ path: "/Media/Movies" }], error: null }),
      listApplications: async () => ({ ok: true, data: overrides.applications ?? [], error: null }),
      testAllDownloadClients: async () => ({ ok: true, data: [{ id: 1, isValid: true }], error: null }),
      testAllApplications: async () => ({ ok: true, data: [{ id: 1, isValid: true }], error: null }),
      downloadClientSchema: async () => ({ ok: true, data: DOWNLOAD_SCHEMA, error: null }),
      applicationSchema: async () => ({ ok: true, data: APPLICATION_SCHEMA, error: null }),
      testDownloadClient: async (serviceId, _base, _key, body) => {
        calls.push({ call: "test-client", serviceId, body });
        return overrides.clientTest || { ok: true, data: [], error: null };
      },
      testApplication: async (_base, _key, body) => {
        calls.push({ call: "test-application", body });
        return overrides.applicationTest || { ok: true, data: [], error: null };
      },
      createDownloadClient: async (serviceId, _base, _key, body) => {
        calls.push({ call: "create-client", serviceId, body });
        return { ok: true, data: { id: 1 }, error: null };
      },
      createApplication: async (_base, _key, body) => {
        calls.push({ call: "create-application", body });
        return { ok: true, data: { id: 2 }, error: null };
      },
      createRootFolder: async (serviceId, _base, _key, folderPath) => {
        calls.push({ call: "create-rootfolder", serviceId, folderPath });
        return { ok: true, data: { id: 3 }, error: null };
      }
    }
  });

  return { service, calls, activity };
}

async function settle(job) {
  while (job.status === JOB_STATUS.PENDING || job.status === JOB_STATUS.RUNNING) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  return job;
}

const fieldOf = (body, name) => body.fields.find((field) => field.name === name)?.value;

// --- payload construction ---

test("a download client payload carries the real key, never the mask an app returns", () => {
  const payload = buildDownloadClientPayload(DOWNLOAD_SCHEMA, {
    name: "SABnzbd",
    host: "198.51.100.10",
    port: 8080,
    apiKey: SAB_KEY
  });

  // Copying a fetched client instead would carry "********", which the app
  // stores verbatim and then fails every request with 403.
  assert.equal(fieldOf(payload, "apiKey"), SAB_KEY);
  assert.notEqual(fieldOf(payload, "apiKey"), MASKED_VALUE);
  assert.equal(payload.configContract, "SabnzbdSettings");
});

test("fields the payload does not name keep the app's own defaults", () => {
  const payload = buildDownloadClientPayload(DOWNLOAD_SCHEMA, { name: "SABnzbd", host: "h", port: 1, apiKey: "k" });

  assert.equal(fieldOf(payload, "movieCategory"), "movies");
});

test("a Prowlarr application syncs additively so hand-added indexers survive", () => {
  const payload = buildApplicationPayload(APPLICATION_SCHEMA, {
    implementation: "Radarr",
    name: "Radarr",
    prowlarrUrl: "http://198.51.100.2:9696",
    baseUrl: "http://198.51.100.2:7878",
    apiKey: RADARR_KEY
  });

  // fullSync would remove indexers Prowlarr does not know about — including the
  // one the user configured directly in Radarr.
  assert.equal(payload.syncLevel, "addOnly");
  assert.equal(fieldOf(payload, "prowlarrUrl"), "http://198.51.100.2:9696");
  assert.equal(fieldOf(payload, "baseUrl"), "http://198.51.100.2:7878");
});

test("asking for an integration the app does not offer fails loudly", () => {
  assert.throws(
    () => buildApplicationPayload(APPLICATION_SCHEMA, { implementation: "Readarr", name: "x" }),
    /does not offer a Readarr integration/
  );
});

// --- the job ---

test("applying creates only what is missing, and tests each payload before writing it", async () => {
  const { service, calls } = createHarness();
  const job = await settle(service.startWiring());

  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);

  const order = calls.map((entry) => entry.call);
  assert.deepEqual(order, [
    "test-client",
    "create-client",
    "test-application",
    "create-application"
  ]);

  const created = calls.find((entry) => entry.call === "create-client");
  assert.equal(fieldOf(created.body, "host"), "sabnzbd");
  assert.equal(fieldOf(created.body, "apiKey"), SAB_KEY);
});

test("a payload the app refuses is never written", async () => {
  const { service, calls } = createHarness({
    clientTest: { ok: false, data: null, error: "Unable to connect to SABnzbd (198.51.100.99:8080)" }
  });
  const job = await settle(service.startWiring());

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.match(job.error.message, /Unable to connect to SABnzbd/);
  assert.equal(calls.filter((entry) => entry.call === "create-client").length, 0);
});

test("a test that answers 200 with validation errors is still a refusal", async () => {
  // Arr apps sometimes return the failure in the body rather than the status.
  const { service, calls } = createHarness({
    applicationTest: {
      ok: true,
      data: [{ isWarning: false, propertyName: "baseUrl", errorMessage: "Unable to connect", detailedDescription: "Unable to connect to Radarr at http://x" }],
      error: null
    }
  });
  const job = await settle(service.startWiring());

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.match(job.error.message, /Unable to connect to Radarr/);
  assert.equal(calls.filter((entry) => entry.call === "create-application").length, 0);
});

test("drift is never written by the apply job, only reported by the check", async () => {
  const drifted = [
    {
      id: 1,
      name: "SABnzbd",
      implementation: "Sabnzbd",
      enable: true,
      fields: [
        { name: "host", value: "198.51.100.99" },
        { name: "port", value: 8080 }
      ]
    }
  ];
  const { service, calls } = createHarness({ downloadClients: drifted });
  const job = await settle(service.startWiring());

  assert.equal(job.status, JOB_STATUS.SUCCEEDED, job.error?.message);
  assert.equal(calls.filter((entry) => entry.call.endsWith("client")).length, 0);
  assert.equal(
    job.steps.find((step) => step.name === "downloadclients").status,
    STEP_STATUS.SKIPPED
  );
});

test("a fully wired stack refuses the job rather than writing duplicates", async () => {
  const { service, calls } = createHarness({
    downloadClients: [
      {
        id: 1,
        name: "SABnzbd",
        implementation: "Sabnzbd",
        enable: true,
        fields: [
          { name: "host", value: "sabnzbd" },
          { name: "port", value: 8080 }
        ]
      }
    ],
    applications: [
      { id: 2, name: "Radarr", implementation: "Radarr", fields: [{ name: "baseUrl", value: "http://radarr:7878" }] }
    ]
  });
  const job = await settle(service.startWiring());

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.match(job.error.message, /Nothing to wire/);
  assert.equal(calls.length, 0);
});

test("a missing library folder is added at the path derived from the container mount", async () => {
  const { service, calls } = createHarness({ rootFolders: [] });
  await settle(service.startWiring());

  const folder = calls.find((entry) => entry.call === "create-rootfolder");
  assert.equal(folder.folderPath, "/Media/Movies");
  assert.ok(!folder.folderPath.startsWith("/share"));
});

test("the job result and activity entry name what was created, and leak no keys", async () => {
  const { service, activity } = createHarness();
  const job = await settle(service.startWiring());
  const payload = JSON.stringify({ result: job.result, steps: job.steps, activity });

  assert.deepEqual(job.result.created, ["Radarr → SABnzbd", "Prowlarr → Radarr"]);
  assert.equal(activity.length, 1);
  assert.equal(payload.match(/\b[0-9a-f]{32}\b/), null);
});
