import test from "node:test";
import assert from "node:assert/strict";

import {
  RECONCILE_STATE,
  reconcileApplication,
  reconcileDownloadClient,
  reconcileRootFolder
} from "../src/lib/wiring/reconcile.js";
import {
  containerPathToHost,
  hostPathToContainer,
  planPathMapping,
  planRootFolder
} from "../src/lib/wiring/path-plan.js";
import { buildDownloadClientPayload, missingCategoryFor } from "../src/lib/wiring/payloads.js";

const DESIRED_SAB = { host: "198.51.100.10", port: 8080 };

function sabClient({ name = "SABnzbd", host = "198.51.100.10", port = 8080, id = 1 } = {}) {
  return {
    id,
    name,
    implementation: "Sabnzbd",
    fields: [
      { name: "host", value: host },
      { name: "port", value: port },
      { name: "movieCategory", value: "movies" }
    ]
  };
}

// --- download clients ---

test("an existing client at the resolved address is correct and needs nothing", () => {
  const result = reconcileDownloadClient([sabClient()], DESIRED_SAB);

  assert.equal(result.state, RECONCILE_STATE.CORRECT);
  assert.deepEqual(result.changes, []);
});

test("a renamed client is still recognized, because identity is never the name", () => {
  // Users rename these freely. Matching on the name would report absent and
  // create a second client beside the working one.
  const result = reconcileDownloadClient([sabClient({ name: "Usenet box" })], DESIRED_SAB);

  assert.equal(result.state, RECONCILE_STATE.CORRECT);
});

test("a client pointing at a stale address is reported as drift with the exact change", () => {
  const result = reconcileDownloadClient([sabClient({ host: "198.51.100.99" })], DESIRED_SAB);

  assert.equal(result.state, RECONCILE_STATE.DRIFT);
  assert.deepEqual(result.changes, [{ field: "host", from: "198.51.100.99", to: "198.51.100.10" }]);
  assert.equal(result.target.id, 1);
});

test("two mismatched clients are ambiguous, and no target is offered to write to", () => {
  const result = reconcileDownloadClient(
    [sabClient({ id: 1, host: "198.51.100.98" }), sabClient({ id: 2, host: "198.51.100.99" })],
    DESIRED_SAB
  );

  assert.equal(result.state, RECONCILE_STATE.AMBIGUOUS);
  assert.equal(result.target, null);
  assert.match(result.reason, /cannot tell which one you meant/);
});

test("a matching client wins even when other mismatched ones exist beside it", () => {
  const result = reconcileDownloadClient([sabClient({ id: 1, host: "198.51.100.99" }), sabClient({ id: 2 })], DESIRED_SAB);

  assert.equal(result.state, RECONCILE_STATE.CORRECT);
  assert.equal(result.target.id, 2);
});

test("download clients of other kinds are not treated as comparable", () => {
  const transmission = { id: 5, name: "Transmission", implementation: "Transmission", fields: [] };
  const result = reconcileDownloadClient([transmission], DESIRED_SAB);

  assert.equal(result.state, RECONCILE_STATE.ABSENT);
});

test("port is compared numerically so a string port does not read as drift", () => {
  const result = reconcileDownloadClient([sabClient({ port: "8080" })], DESIRED_SAB);

  assert.equal(result.state, RECONCILE_STATE.CORRECT);
});

// --- Prowlarr applications ---

test("a Prowlarr application is matched on baseUrl, ignoring a trailing slash", () => {
  const existing = [
    { id: 3, name: "Radarr", implementation: "Radarr", fields: [{ name: "baseUrl", value: "http://198.51.100.2:7878/" }] }
  ];
  const result = reconcileApplication(existing, { implementation: "Radarr", baseUrl: "http://198.51.100.2:7878" });

  assert.equal(result.state, RECONCILE_STATE.CORRECT);
});

test("a Prowlarr application pointing at the wrong app URL is drift", () => {
  const existing = [
    { id: 3, name: "Radarr", implementation: "Radarr", fields: [{ name: "baseUrl", value: "http://radarr:7878" }] }
  ];
  const result = reconcileApplication(existing, { implementation: "Radarr", baseUrl: "http://198.51.100.2:7878" });

  assert.equal(result.state, RECONCILE_STATE.DRIFT);
  assert.equal(result.changes[0].field, "baseUrl");
});

// --- root folders ---

test("any root folder inside the media mount counts as configured", () => {
  // A library at /Media/Films is a choice, not a fault.
  const result = reconcileRootFolder([{ path: "/Media/Films" }], {
    mountPath: "/Media",
    expectedPath: "/Media/Movies"
  });

  assert.equal(result.state, RECONCILE_STATE.CORRECT);
});

test("no root folder inside the media mount is absent, and names what would be added", () => {
  const result = reconcileRootFolder([{ path: "/downloads" }], {
    mountPath: "/Media",
    expectedPath: "/Media/Movies"
  });

  assert.equal(result.state, RECONCILE_STATE.ABSENT);
  assert.match(result.reason, /\/Media\/Movies/);
});

// --- paths ---

const ARR_MOUNTS = [
  { source: "/share/CACHEDEV1_DATA/.../volumes/abc/_data", target: "/config" },
  { source: "/share/Media", target: "/Media" }
];

test("a root folder is derived from the container mount, never from the host media root", () => {
  const result = planRootFolder(ARR_MOUNTS, "radarr", "/share/Media");

  assert.equal(result.expectedPath, "/Media/Movies");
  // The trap: /share/Media is the host path. Radarr only ever sees /Media, and
  // would accept /share/Media/Movies while never finding anything in it.
  assert.ok(!result.expectedPath.startsWith("/share"));
});

test("an app with no media mount cannot be given a root folder", () => {
  const result = planRootFolder([{ source: "/x", target: "/config" }], "radarr", "/share/Media");

  assert.equal(result.ok, false);
  assert.match(result.reason, /does not mount/);
});

test("paths translate in both directions through the longest matching mount", () => {
  assert.equal(containerPathToHost(ARR_MOUNTS, "/Media/Downloads/complete"), "/share/Media/Downloads/complete");
  assert.equal(hostPathToContainer(ARR_MOUNTS, "/share/Media/Downloads/complete"), "/Media/Downloads/complete");
});

test("matching containers see completed downloads identically, so no mapping is needed", () => {
  const result = planPathMapping({
    downloadMounts: [{ source: "/share/Media", target: "/Media" }],
    completeDir: "/Media/Downloads/complete",
    arrMounts: ARR_MOUNTS,
    downloadHost: "198.51.100.10"
  });

  assert.equal(result.needed, false);
  assert.equal(result.blocked, false);
});

test("containers that mount the same data at different paths need a mapping", () => {
  const result = planPathMapping({
    downloadMounts: [{ source: "/share/Media", target: "/data" }],
    completeDir: "/data/Downloads/complete",
    arrMounts: ARR_MOUNTS,
    downloadHost: "198.51.100.10"
  });

  assert.equal(result.needed, true);
  assert.deepEqual(result.mapping, {
    host: "198.51.100.10",
    remotePath: "/data/Downloads/complete",
    localPath: "/Media/Downloads/complete"
  });
});

test("a missing mount is blocked rather than papered over with a mapping", () => {
  const result = planPathMapping({
    downloadMounts: [{ source: "/share/Elsewhere", target: "/data" }],
    completeDir: "/data/complete",
    arrMounts: ARR_MOUNTS,
    downloadHost: "198.51.100.10"
  });

  assert.equal(result.blocked, true);
  assert.match(result.reason, /cannot fix a missing mount/);
});

// --- download clients other than SABnzbd ---

test("a torrent client is registered with its own implementation and credentials", () => {
  // Same idea as SABnzbd, different authentication: qBittorrent wants a
  // username and password where SABnzbd wants an API key.
  const schemas = [
    { implementation: "Sabnzbd", fields: [{ name: "host" }, { name: "port" }, { name: "apiKey" }, { name: "useSsl" }] },
    {
      implementation: "QBittorrent",
      fields: [{ name: "host" }, { name: "port" }, { name: "username" }, { name: "password" }, { name: "useSsl" }]
    }
  ];

  const payload = buildDownloadClientPayload(schemas, {
    serviceId: "qbittorrent",
    name: "qBittorrent",
    host: "qbittorrent",
    port: 8090,
    username: "admin",
    password: "chosen-by-the-operator"
  });

  assert.equal(payload.implementation, "QBittorrent");
  assert.equal(payload.enable, true);
  const byName = Object.fromEntries(payload.fields.map((f) => [f.name, f.value]));
  assert.equal(byName.host, "qbittorrent");
  assert.equal(byName.port, 8090);
  assert.equal(byName.username, "admin");
  assert.equal(byName.password, "chosen-by-the-operator");
});

test("credentials meant for one client are not written into another", () => {
  const schemas = [
    { implementation: "Sabnzbd", fields: [{ name: "host" }, { name: "apiKey" }, { name: "useSsl" }] }
  ];

  // An apiKey passed alongside a torrent client would be a field SABnzbd has
  // and qBittorrent does not; the reverse would silently drop the password.
  const payload = buildDownloadClientPayload(schemas, {
    serviceId: "sabnzbd",
    name: "SABnzbd",
    host: "sabnzbd",
    apiKey: "sab-key",
    password: "not-sabnzbd's-business"
  });

  const names = payload.fields.map((f) => f.name);
  assert.equal(names.includes("password"), false);
  assert.equal(payload.fields.find((f) => f.name === "apiKey").value, "sab-key");
});

test("an unknown download client is refused rather than guessed at", () => {
  assert.throws(
    () => buildDownloadClientPayload([], { serviceId: "deluge", name: "Deluge", host: "deluge", port: 8112 }),
    /not a download client Keelarr knows/
  );
});

test("a missing category is looked up against the right client's schema", () => {
  const schemas = [
    { implementation: "Sabnzbd", fields: [{ name: "movieCategory", value: "movies" }] },
    { implementation: "QBittorrent", fields: [{ name: "movieCategory", value: "radarr" }] }
  ];

  // Both clients want a category for Radarr, and they are different strings.
  assert.equal(missingCategoryFor(schemas, "radarr", [], "sabnzbd"), "movies");
  assert.equal(missingCategoryFor(schemas, "radarr", [], "qbittorrent"), "radarr");
  assert.equal(missingCategoryFor(schemas, "radarr", ["radarr"], "qbittorrent"), null);
});
