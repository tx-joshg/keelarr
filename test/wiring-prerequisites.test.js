import test from "node:test";
import assert from "node:assert/strict";

import { findMissingPrerequisites, settingsLinkFor } from "../src/lib/wiring/prerequisites.js";

const services = (...ids) => ids.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) }));

const APP_URLS = {
  prowlarr: "http://198.51.100.2:9696",
  radarr: "http://198.51.100.2:7878",
  lidarr: "http://198.51.100.2:8686",
  sabnzbd: "http://198.51.100.10:8080",
  tautulli: "http://198.51.100.2:8181"
};

function apps(entries) {
  return new Map(Object.entries(entries));
}

test("an empty Prowlarr is reported, because nothing downstream can find anything", () => {
  const missing = findMissingPrerequisites({
    apps: apps({ prowlarr: { reachable: true, indexerCount: 0 } }),
    services: services("prowlarr"),
    appUrls: APP_URLS
  });

  assert.equal(missing.length, 1);
  assert.equal(missing[0].requirement, "indexer");
  assert.match(missing[0].consequence, /Nothing in this stack can find releases/);
  assert.equal(missing[0].link, "http://198.51.100.2:9696/settings/indexers");
});

test("an app with no indexers of its own is fine while Prowlarr has some to sync", () => {
  // Reporting it here would be noise: Prowlarr is about to fill them in.
  const missing = findMissingPrerequisites({
    apps: apps({
      prowlarr: { reachable: true, indexerCount: 3 },
      lidarr: { reachable: true, indexerCount: 0 }
    }),
    services: services("prowlarr", "lidarr"),
    appUrls: APP_URLS
  });

  assert.deepEqual(missing, []);
});

test("an app with no indexers and an empty Prowlarr is reported, and so is Prowlarr", () => {
  // This is the live case: every connection correct, nothing able to search.
  const missing = findMissingPrerequisites({
    apps: apps({
      prowlarr: { reachable: true, indexerCount: 0 },
      lidarr: { reachable: true, indexerCount: 0 }
    }),
    services: services("prowlarr", "lidarr"),
    appUrls: APP_URLS
  });

  assert.deepEqual(missing.map((entry) => entry.serviceId), ["prowlarr", "lidarr"]);
  assert.match(missing[1].summary, /Prowlarr has none to give it/);
});

test("a count that could not be read is not reported as zero", () => {
  // Claiming an app has no indexers because a call failed sends the operator
  // hunting for a problem that is not there.
  const missing = findMissingPrerequisites({
    apps: apps({ prowlarr: { reachable: true, indexerCount: null }, radarr: { reachable: true, indexerCount: null } }),
    services: services("prowlarr", "radarr"),
    appUrls: APP_URLS
  });

  assert.deepEqual(missing, []);
});

test("SABnzbd with no Usenet account is reported", () => {
  const missing = findMissingPrerequisites({
    apps: apps({ sabnzbd: { reachable: true, serverCount: 0 } }),
    services: services("sabnzbd"),
    appUrls: APP_URLS
  });

  assert.equal(missing[0].requirement, "usenet-account");
  assert.match(missing[0].consequence, /Downloads cannot start/);
  assert.equal(missing[0].link, "http://198.51.100.10:8080/config/server/");
});

test("SABnzbd with an account configured is not nagged about", () => {
  const missing = findMissingPrerequisites({
    apps: apps({ sabnzbd: { reachable: true, serverCount: 1 } }),
    services: services("sabnzbd"),
    appUrls: APP_URLS
  });

  assert.deepEqual(missing, []);
});

test("Tautulli without a Plex link is reported, and with one is not", () => {
  const unlinked = findMissingPrerequisites({
    apps: apps({ tautulli: { reachable: true, plexLinked: false } }),
    services: services("tautulli"),
    appUrls: APP_URLS
  });
  const linked = findMissingPrerequisites({
    apps: apps({ tautulli: { reachable: true, plexLinked: true } }),
    services: services("tautulli"),
    appUrls: APP_URLS
  });

  assert.equal(unlinked[0].requirement, "plex");
  assert.deepEqual(linked, []);
});

test("an unreadable Tautulli config is left alone rather than guessed at", () => {
  const missing = findMissingPrerequisites({
    apps: apps({ tautulli: { reachable: false, plexLinked: null } }),
    services: services("tautulli"),
    appUrls: APP_URLS
  });

  assert.deepEqual(missing, []);
});

test("a service that is not part of the stack is never reported", () => {
  const missing = findMissingPrerequisites({
    apps: apps({ prowlarr: { reachable: true, indexerCount: 0 } }),
    services: services("radarr"),
    appUrls: APP_URLS
  });

  assert.deepEqual(missing, []);
});

test("the link lands on the settings page, not the app's front door", () => {
  assert.equal(settingsLinkFor("radarr", "http://h:7878"), "http://h:7878/settings/indexers");
  assert.equal(settingsLinkFor("sabnzbd", "http://h:8080/"), "http://h:8080/config/server/");
  // An app with no known settings path still gets something clickable.
  assert.equal(settingsLinkFor("ombi", "http://h:3579"), "http://h:3579");
});
