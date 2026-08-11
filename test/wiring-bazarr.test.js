import test from "node:test";
import assert from "node:assert/strict";

import { parseBazarrApiKey, readApiKey } from "../src/lib/wiring/api-keys.js";
import { RECONCILE_STATE, reconcileSettingsLink } from "../src/lib/wiring/reconcile.js";
import { findMissingPrerequisites } from "../src/lib/wiring/prerequisites.js";

/**
 * Bazarr's real config shape. The `auth:` block holds Bazarr's own key, while
 * `sonarr:` and `radarr:` hold the keys of the apps it talks to — which is why
 * a plain search for `apikey` finds the wrong one.
 */
const CONFIG = `general:
  use_radarr: false
  use_sonarr: false
auth:
  apikey: 1111111111111111111111111111aaaa
  type: form
radarr:
  apikey: 2222222222222222222222222222bbbb
  base_url: /
  ip: 127.0.0.1
  port: 7878
  ssl: false
sonarr:
  apikey: 3333333333333333333333333333cccc
  ip: 127.0.0.1
  port: 8989
`;

test("Bazarr's own key is read, not one of the keys it stores for other apps", () => {
  // The first apikey in the file belongs to auth; the later ones are Radarr's
  // and Sonarr's. Taking whichever came first would hand back the wrong app's.
  assert.equal(parseBazarrApiKey(CONFIG), "1111111111111111111111111111aaaa");
});

test("a config without an auth block yields nothing rather than a neighbour's key", () => {
  const withoutAuth = "radarr:\n  apikey: 2222222222222222222222222222bbbb\n";

  assert.equal(parseBazarrApiKey(withoutAuth), null);
});

test("Bazarr is read from its own config path", async () => {
  const result = await readApiKey(
    { dockerBin: "docker" },
    { id: "bazarr", name: "Bazarr", containerName: "bazarr" },
    { readContainerFileImpl: async (_s, _c, p) => (p === "/config/config/config.yaml" ? CONFIG : null) }
  );

  assert.equal(result.key, "1111111111111111111111111111aaaa");
  assert.equal(result.descriptor.source, "/config/config/config.yaml");
  assert.ok(!JSON.stringify(result.descriptor).includes("1111"));
});

// --- reconciling a settings document rather than a collection ---

test("a link that is switched off is absent, however its fields are set", () => {
  // Bazarr ships pointing at 127.0.0.1 with the toggle off. Those defaults are
  // not a configuration someone chose, so this is absent rather than drift.
  const result = reconcileSettingsLink({
    enabled: false,
    current: { ip: "127.0.0.1", port: 7878 },
    desired: { ip: "198.51.100.2", port: 7878 },
    describe: "Radarr in Bazarr"
  });

  assert.equal(result.state, RECONCILE_STATE.ABSENT);
});

test("a link switched on and pointing at the right place is correct", () => {
  const result = reconcileSettingsLink({
    enabled: true,
    current: { ip: "198.51.100.2", port: 7878 },
    desired: { ip: "198.51.100.2", port: 7878 },
    describe: "Radarr in Bazarr"
  });

  assert.equal(result.state, RECONCILE_STATE.CORRECT);
  assert.deepEqual(result.changes, []);
});

test("a link switched on but aimed elsewhere is drift, and is left alone", () => {
  const result = reconcileSettingsLink({
    enabled: true,
    current: { ip: "203.0.113.19", port: 7878 },
    desired: { ip: "198.51.100.2", port: 7878 },
    describe: "Radarr in Bazarr"
  });

  assert.equal(result.state, RECONCILE_STATE.DRIFT);
  assert.deepEqual(result.changes, [{ field: "ip", from: "203.0.113.19", to: "198.51.100.2" }]);
});

test("a port stored as a number matches one compared as a string", () => {
  const result = reconcileSettingsLink({
    enabled: true,
    current: { ip: "198.51.100.2", port: 7878 },
    desired: { ip: "198.51.100.2", port: "7878" },
    describe: "Radarr in Bazarr"
  });

  assert.equal(result.state, RECONCILE_STATE.CORRECT);
});

// --- the prerequisite only a person can settle ---

test("Bazarr with no language profile is reported, with what it costs", () => {
  const missing = findMissingPrerequisites({
    apps: new Map([["bazarr", { reachable: true, languageProfiles: 0 }]]),
    services: [{ id: "bazarr", name: "Bazarr" }],
    appUrls: { bazarr: "http://198.51.100.2:6767" }
  });

  assert.equal(missing[0].requirement, "language-profile");
  assert.match(missing[0].consequence, /will not fetch subtitles/);
  assert.equal(missing[0].link, "http://198.51.100.2:6767/settings/languages");
});

test("Bazarr with a language profile is not nagged about", () => {
  const missing = findMissingPrerequisites({
    apps: new Map([["bazarr", { reachable: true, languageProfiles: 2 }]]),
    services: [{ id: "bazarr", name: "Bazarr" }],
    appUrls: {}
  });

  assert.deepEqual(missing, []);
});

test("a profile count that could not be read is not reported as zero", () => {
  const missing = findMissingPrerequisites({
    apps: new Map([["bazarr", { reachable: true, languageProfiles: null }]]),
    services: [{ id: "bazarr", name: "Bazarr" }],
    appUrls: {}
  });

  assert.deepEqual(missing, []);
});
