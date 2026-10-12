import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPATIBILITY_SEVERITY,
  detectMediaServers,
  evaluateCompatibility,
  resolvePorts,
  summarizeBlocked
} from "../src/lib/compatibility.js";

const idsOf = (findings) => findings.map((finding) => finding.id).sort();
const find = (result, id) => result.findings.find((finding) => finding.id === id) || null;

// --- what refuses, and what only speaks up ---

test("a sensible stack is accepted with nothing to say about it", () => {
  const result = evaluateCompatibility({
    selectedServiceIds: ["prowlarr", "radarr", "sonarr", "sabnzbd", "bazarr", "jellyfin", "seerr"]
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});

test("two apps on one port is the one thing refused outright", () => {
  const result = evaluateCompatibility({
    selectedServiceIds: ["sabnzbd", "qbittorrent"],
    // qBittorrent's own default is 8080, which SABnzbd already holds. The
    // catalog moves it to 8090 precisely to avoid this; an override puts it back.
    serviceOverrides: { qbittorrent: { port: 8080 } }
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].severity, COMPATIBILITY_SEVERITY.BLOCKED);
  assert.deepEqual(result.blocked[0].subjects.sort(), ["qbittorrent", "sabnzbd"]);
  assert.match(result.blocked[0].consequence, /cannot bind the port/);
});

test("the catalog's own defaults never collide", () => {
  // A regression guard with teeth: adding an app on a port already in use would
  // make every default selection refuse to start.
  const result = evaluateCompatibility({
    selectedServiceIds: [
      "prowlarr", "flaresolverr", "sabnzbd", "qbittorrent", "radarr", "sonarr",
      "lidarr", "bazarr", "jellyfin", "trailarr", "seerr", "ombi", "tautulli"
    ]
  });

  assert.deepEqual(result.blocked, []);
});

test("a conflict is reported but never refused, because it is the operator's call", () => {
  const result = evaluateCompatibility({ selectedServiceIds: ["seerr", "ombi", "jellyfin", "radarr", "sabnzbd", "prowlarr"] });

  assert.equal(result.ok, true);
  assert.deepEqual(idsOf(result.conflicts), ["two-request-portals"]);
  // Someone migrating from Ombi to Seerr runs both on purpose for a while.
  assert.match(find(result, "two-request-portals").remedy, /worth knowing, not worth stopping/);
});

// --- the Seerr rules, which is why this module exists ---

test("Seerr with no media server anywhere is a conflict, not advice", () => {
  const result = evaluateCompatibility({ selectedServiceIds: ["seerr", "radarr"] });

  assert.deepEqual(idsOf(result.conflicts), ["seerr-without-media-server"]);
  assert.match(find(result, "seerr-without-media-server").consequence, /sit on its setup screen/);
});

test("Seerr beside a selected Jellyfin is fine", () => {
  const result = evaluateCompatibility({ selectedServiceIds: ["seerr", "jellyfin"] });

  assert.equal(find(result, "seerr-without-media-server"), null);
});

test("Seerr beside a Plex Keelarr does not manage is also fine", () => {
  // The case that makes this rule honest. Keelarr has no Plex catalog entry, so
  // a perfectly good Plex is invisible unless the scan is consulted.
  const result = evaluateCompatibility({
    selectedServiceIds: ["seerr"],
    discovered: [{ name: "plex", image: "plexinc/pms-docker:latest" }]
  });

  assert.equal(find(result, "seerr-without-media-server"), null);
});

test("an unmanaged Emby counts as a media server too", () => {
  const result = evaluateCompatibility({
    selectedServiceIds: ["seerr"],
    discovered: [{ name: "emby", image: "lscr.io/linuxserver/emby" }]
  });

  assert.equal(find(result, "seerr-without-media-server"), null);
});

// --- Tautulli, the app whose premise the catalog quietly contradicts ---

test("Tautulli on a Jellyfin stack is told it only reads Plex", () => {
  const result = evaluateCompatibility({ selectedServiceIds: ["tautulli", "jellyfin"] });

  assert.deepEqual(idsOf(result.advice).includes("tautulli-is-plex-only"), true);
  assert.match(find(result, "tautulli-is-plex-only").consequence, /cannot read anything from Jellyfin/);
});

test("Tautulli beside a real Plex says nothing", () => {
  const result = evaluateCompatibility({
    selectedServiceIds: ["tautulli"],
    discovered: [{ name: "plex", image: "plexinc/pms-docker" }]
  });

  assert.equal(find(result, "tautulli-is-plex-only"), null);
});

// --- Ombi, without overclaiming ---

test("Ombi on a Jellyfin stack is pointed at Seerr without being called broken", () => {
  const result = evaluateCompatibility({ selectedServiceIds: ["ombi", "jellyfin"] });
  const finding = find(result, "ombi-on-a-jellyfin-stack");

  // Ombi does support Jellyfin. The honest difference is that Keelarr can wire
  // Seerr and cannot wire Ombi, so that is what the text has to say.
  assert.equal(finding.severity, COMPATIBILITY_SEVERITY.ADVICE);
  assert.match(finding.consequence, /Ombi works with Jellyfin/);
});

test("Ombi is left alone once Seerr is already chosen", () => {
  // The two-portal conflict already covers this; saying it twice is noise.
  const result = evaluateCompatibility({ selectedServiceIds: ["ombi", "jellyfin", "seerr"] });

  assert.equal(find(result, "ombi-on-a-jellyfin-stack"), null);
});

// --- the "this will install and do nothing" family ---

test("an acquirer with no download client is told what will not happen", () => {
  const result = evaluateCompatibility({ selectedServiceIds: ["radarr", "prowlarr"] });

  assert.match(find(result, "acquirer-without-download-client").consequence, /^It can find releases/);
});

test("several acquirers are reported once, together, in plural", () => {
  const result = evaluateCompatibility({ selectedServiceIds: ["radarr", "sonarr", "prowlarr"] });
  const finding = find(result, "acquirer-without-download-client");

  assert.deepEqual(finding.subjects, ["radarr", "sonarr"]);
  assert.match(finding.consequence, /^They can find releases/);
});

test("a download client with nothing to serve is told so", () => {
  const result = evaluateCompatibility({ selectedServiceIds: ["sabnzbd"] });

  assert.deepEqual(idsOf(result.advice), ["download-client-without-acquirer"]);
});

test("Bazarr alone is told it has no library to work from", () => {
  const result = evaluateCompatibility({ selectedServiceIds: ["bazarr"] });

  assert.deepEqual(idsOf(result.advice), ["bazarr-without-library-apps"]);
});

test("Bazarr with Sonarr only is satisfied", () => {
  const result = evaluateCompatibility({ selectedServiceIds: ["sonarr", "bazarr", "sabnzbd", "prowlarr"] });

  assert.equal(find(result, "bazarr-without-library-apps"), null);
});

test("FlareSolverr without Prowlarr is told nothing will ever ask it anything", () => {
  const result = evaluateCompatibility({ selectedServiceIds: ["flaresolverr"] });

  assert.deepEqual(idsOf(result.advice), ["flaresolverr-without-prowlarr"]);
});

test("an empty selection is accepted and advised about nothing", () => {
  const result = evaluateCompatibility({ selectedServiceIds: [] });

  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});

test("an unknown service id is ignored rather than crashing the evaluation", () => {
  const result = evaluateCompatibility({ selectedServiceIds: ["radarr", "readarr", "sabnzbd", "prowlarr"] });

  assert.equal(result.ok, true);
});

// --- the pieces, directly ---

test("ports come from the override when there is one", () => {
  assert.deepEqual(
    resolvePorts(["radarr"], { radarr: { port: 17878 } }),
    [{ serviceId: "radarr", name: "Radarr", port: 17878 }]
  );
  assert.deepEqual(resolvePorts(["radarr"]), [{ serviceId: "radarr", name: "Radarr", port: 7878 }]);
});

test("media server detection ignores the tag and the registry", () => {
  assert.deepEqual(
    detectMediaServers([{ image: "ghcr.io/linuxserver/plex:1.41" }]),
    ["linuxserver/plex"]
  );
});

test("media server detection does not mistake an Arr app for a media server", () => {
  assert.deepEqual(detectMediaServers([{ image: "lscr.io/linuxserver/radarr:latest" }]), []);
  assert.deepEqual(detectMediaServers([{}, { image: "" }, null]), []);
});

test("the refusal names the apps and what will happen", () => {
  const result = evaluateCompatibility({
    selectedServiceIds: ["radarr", "sonarr"],
    serviceOverrides: { sonarr: { port: 7878 } }
  });
  const sentence = summarizeBlocked(result.blocked);

  assert.match(sentence, /Radarr and Sonarr are both set to port 7878/);
  assert.match(sentence, /cannot bind the port/);
});

test("nothing blocked summarizes to nothing", () => {
  assert.equal(summarizeBlocked([]), "");
});
