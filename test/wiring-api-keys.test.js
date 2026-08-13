import test from "node:test";
import assert from "node:assert/strict";

import {
  fingerprintKey,
  hasReadableApiKey,
  parseArrApiKey,
  parseSabnzbdConfig,
  readApiKey
} from "../src/lib/wiring/api-keys.js";

const FAKE_KEY = "0123456789abcdef0123456789abcdef";

const ARR_CONFIG = `<Config>
  <BindAddress>*</BindAddress>
  <Port>7878</Port>
  <ApiKey>${FAKE_KEY}</ApiKey>
  <AuthenticationMethod>forms</AuthenticationMethod>
  <InstanceName>Radarr</InstanceName>
</Config>`;

const SAB_CONFIG = `__version__ = 19
[misc]
host = ::
port = 8080
api_key = ${FAKE_KEY}
nzb_key = ffffffffffffffffffffffffffffffff
download_dir = /Media/Downloads/incomplete
complete_dir = /Media/Downloads/complete
host_whitelist = 4e00ff32987e, 198.51.100.10, sabnzbd, sabnzbd.local
[servers]
host = news.usenet.example
port = 563
`;

function settings() {
  return { dockerBin: "docker" };
}

function service(id, name) {
  return { id, name, containerName: id };
}

function reader(files) {
  return async (_settings, containerName, filePath) => files[`${containerName}:${filePath}`] ?? null;
}

test("an Arr API key is read out of config.xml", async () => {
  const result = await readApiKey(settings(), service("radarr", "Radarr"), {
    readContainerFileImpl: reader({ "radarr:/config/config.xml": ARR_CONFIG })
  });

  assert.equal(result.key, FAKE_KEY);
  assert.equal(result.descriptor.found, true);
  assert.equal(result.descriptor.source, "/config/config.xml");
});

test("the SABnzbd key, paths, and host whitelist all come from one read", async () => {
  const result = await readApiKey(settings(), service("sabnzbd", "SABnzbd"), {
    readContainerFileImpl: reader({ "sabnzbd:/config/sabnzbd.ini": SAB_CONFIG })
  });

  assert.equal(result.key, FAKE_KEY);
  assert.equal(result.downloadSettings.completeDir, "/Media/Downloads/complete");
  assert.deepEqual(result.downloadSettings.hostWhitelist, [
    "4e00ff32987e",
    "198.51.100.10",
    "sabnzbd",
    "sabnzbd.local"
  ]);
});

test("the download settings never carry the api key along with them", async () => {
  const result = await readApiKey(settings(), service("sabnzbd", "SABnzbd"), {
    readContainerFileImpl: reader({ "sabnzbd:/config/sabnzbd.ini": SAB_CONFIG })
  });

  // parseSabnzbdConfig returns the key, so a pass-through here would smuggle it
  // into anything that serializes downloadSettings.
  assert.ok(!JSON.stringify(result.downloadSettings).includes(FAKE_KEY));
  assert.equal(result.downloadSettings.apiKey, undefined);
});

test("the public descriptor carries a fingerprint, never the key", async () => {
  const result = await readApiKey(settings(), service("radarr", "Radarr"), {
    readContainerFileImpl: reader({ "radarr:/config/config.xml": ARR_CONFIG })
  });

  assert.ok(!JSON.stringify(result.descriptor).includes(FAKE_KEY));
  assert.equal(result.descriptor.fingerprint, fingerprintKey(FAKE_KEY));
  assert.equal(result.descriptor.fingerprint.length, 8);
});

test("a config file that does not exist yet reports pending, not missing", async () => {
  const result = await readApiKey(settings(), service("prowlarr", "Prowlarr"), {
    readContainerFileImpl: reader({})
  });

  // A freshly installed app writes config.xml a few seconds after first start.
  // Calling that "missing" turns a normal startup into a scary red result.
  assert.equal(result.key, null);
  assert.equal(result.descriptor.state, "pending");
  assert.match(result.descriptor.reason, /has not written/);
});

test("a config file present but without a key yet also reports pending", async () => {
  const result = await readApiKey(settings(), service("prowlarr", "Prowlarr"), {
    readContainerFileImpl: reader({ "prowlarr:/config/config.xml": "<Config>\n  <Port>9696</Port>\n</Config>" })
  });

  assert.equal(result.descriptor.state, "pending");
});

test("an app Keelarr does not read a key for says so rather than reporting a failure", async () => {
  const result = await readApiKey(settings(), service("tautulli", "Tautulli"), {
    readContainerFileImpl: reader({})
  });

  assert.equal(result.descriptor.state, "unsupported");
  assert.equal(hasReadableApiKey("tautulli"), false);
  assert.equal(hasReadableApiKey("radarr"), true);
});

test("a truncated or malformed config yields no key rather than a partial one", () => {
  assert.equal(parseArrApiKey("<Config>\n  <ApiKey>0123456789ab"), null);
  assert.equal(parseArrApiKey("<Config><ApiKey></ApiKey></Config>"), null);
  assert.equal(parseArrApiKey(""), null);
  assert.equal(parseSabnzbdConfig("[misc]\nport = 8080\n").apiKey, null);
});

test("commented-out settings are not mistaken for real ones", () => {
  const parsed = parseSabnzbdConfig(`[misc]\n#api_key = ${FAKE_KEY}\napi_key = beef${"0".repeat(28)}\n`);

  assert.equal(parsed.apiKey, `beef${"0".repeat(28)}`);
});
