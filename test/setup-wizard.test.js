import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHttpApp } from "../src/create-http-app.js";
import { DemoKeelarrAppService } from "../src/lib/demo-service.js";
import { HostProfileService } from "../src/lib/app-services/host-profile-service.js";
import { buildWizardView } from "../src/lib/setup-wizard.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");

const silentLogger = (() => {
  const noop = () => {};
  const make = () => ({ child: make, debug: noop, info: noop, warn: noop, error: noop });
  return make();
})();

// --- the view, as a pure function ---

const SETTINGS = { initialized: true, selectedServiceIds: ["radarr"], serviceOverrides: {} };

test("every catalog app appears, whether chosen or not", () => {
  const view = buildWizardView({ settings: SETTINGS, inventory: { items: [] } });

  // A picker that only lists what is already selected cannot be used to add
  // anything, which was the bug that made the catalog invisible in the UI once.
  assert.ok(view.catalog.length >= 13);
  assert.ok(view.catalog.some((entry) => entry.id === "seerr"));
  assert.equal(view.catalog.find((entry) => entry.id === "radarr").selected, true);
  assert.equal(view.catalog.find((entry) => entry.id === "sonarr").selected, false);
});

test("an app with nothing running is an install", () => {
  const view = buildWizardView({ settings: SETTINGS, inventory: { items: [] } });

  assert.equal(view.catalog.find((entry) => entry.id === "sonarr").action, "install");
  assert.equal(view.catalog.find((entry) => entry.id === "sonarr").existing, null);
});

test("an unselected app already running on the host is an adoption, not an install", () => {
  const view = buildWizardView({
    settings: SETTINGS,
    inventory: {
      items: [{
        containerId: "abc123",
        name: "sonarr",
        image: "lscr.io/linuxserver/sonarr:latest",
        status: "running",
        recognized: true,
        serviceId: "sonarr",
        adoptable: true,
        issues: []
      }]
    }
  });
  const row = view.catalog.find((entry) => entry.id === "sonarr");

  // The distinction the operator is actually agreeing to.
  assert.equal(row.action, "adopt");
  assert.equal(row.existing.containerId, "abc123");
  assert.equal(row.existing.adoptable, true);
});

test("an app both selected and running is already managed", () => {
  const view = buildWizardView({
    settings: SETTINGS,
    inventory: {
      items: [{ containerId: "r1", name: "radarr", recognized: true, serviceId: "radarr", adoptable: true, issues: [] }]
    }
  });

  assert.equal(view.catalog.find((entry) => entry.id === "radarr").action, "managed");
});

test("a container adoption would refuse is reported as such rather than promised", () => {
  const view = buildWizardView({
    settings: SETTINGS,
    inventory: {
      items: [{
        containerId: "x1",
        name: "sonarr",
        recognized: true,
        serviceId: "sonarr",
        adoptable: false,
        issues: [
          { level: "warn", message: "Config path could not be determined." },
          { level: "info", message: "Running on a bridge network." }
        ]
      }]
    }
  });
  const row = view.catalog.find((entry) => entry.id === "sonarr");

  assert.equal(row.existing.adoptable, false);
  // Info-level notes are noise in a picker; the warning is the part that matters.
  assert.deepEqual(row.existing.issues.map((issue) => issue.level), ["warn"]);
});

test("two containers of one app do not make the picker choose between them", () => {
  const view = buildWizardView({
    settings: SETTINGS,
    inventory: {
      items: [
        { containerId: "first", name: "sonarr", recognized: true, serviceId: "sonarr", adoptable: true, issues: [] },
        { containerId: "second", name: "sonarr-4k", recognized: true, serviceId: "sonarr", adoptable: true, issues: [] }
      ]
    }
  });

  assert.equal(view.catalog.find((entry) => entry.id === "sonarr").existing.containerId, "first");
});

test("containers Keelarr does not recognise are reported rather than hidden", () => {
  const view = buildWizardView({
    settings: SETTINGS,
    inventory: {
      items: [{ name: "nginx", image: "nginx:alpine", recognized: false, serviceId: null, issues: [] }]
    }
  });

  assert.deepEqual(view.unrecognized, [{ name: "nginx", image: "nginx:alpine" }]);
});

test("the view carries the compatibility of the selection it describes", () => {
  const view = buildWizardView({
    settings: { initialized: true, selectedServiceIds: ["seerr"], serviceOverrides: {} },
    inventory: { items: [] }
  });

  assert.equal(view.compatibility.conflicts[0].id, "seerr-without-media-server");
});

test("a port override is reflected in the row, so a collision is visible where it is made", () => {
  const view = buildWizardView({
    settings: { initialized: true, selectedServiceIds: ["radarr"], serviceOverrides: { radarr: { port: 17878 } } },
    inventory: { items: [] }
  });

  assert.equal(view.catalog.find((entry) => entry.id === "radarr").port, 17878);
  assert.equal(view.catalog.find((entry) => entry.id === "radarr").defaultPort, 7878);
});

// --- the write path refuses what cannot run ---

/**
 * Deliberately exercises `prepareSetup` rather than `saveProfile`: saveProfile
 * calls `syncControllerEnv`, which is a method rather than an injected
 * implementation and writes deploy/.env on the real filesystem. A test suite
 * once overwrote a live controller's env file that way.
 */
function profileService({ settings, onSave = async (input) => input }) {
  return new HostProfileService({
    logger: silentLogger,
    loadSettingsImpl: async () => settings,
    normalizeSettingsImpl: (input) => input,
    saveSettingsImpl: onSave,
    appendActivityImpl: async () => [],
    writeStacksImpl: async () => [],
    detectHostEnvironmentImpl: async () => ({
      selected: { adapterId: "generic-docker", label: "Docker", suggestedSettings: {} },
      detections: []
    }),
    validateHostProfileImpl: async () => ({ ok: true, errors: [], warnings: [], fieldResults: {} })
  });
}

const BASE = {
  initialized: true,
  adapterType: "generic-docker",
  hostUrl: "http://localhost",
  selectedServiceIds: ["sabnzbd"],
  serviceOverrides: {},
  services: {}
};

test("setup refuses a selection whose ports collide, and saves nothing", async () => {
  let saved = false;
  const service = profileService({
    settings: BASE,
    onSave: async (input) => {
      saved = true;
      return input;
    }
  });

  await assert.rejects(
    () => service.prepareSetup({
      selectedServiceIds: ["sabnzbd", "qbittorrent"],
      serviceOverrides: { qbittorrent: { port: 8080 } }
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /both set to port 8080/);
      // The finding rides along so the UI can point at the right two rows.
      assert.equal(error.details.compatibility.blocked.length, 1);
      return true;
    }
  );

  // The important half: a refusal must not have written first.
  assert.equal(saved, false);
});

test("a selection with only conflicts and advice is saved without complaint", async () => {
  let saved = null;
  const service = profileService({ settings: BASE, onSave: async (input) => { saved = input; return input; } });

  // Seerr with no media server and no download client: two findings, both the
  // operator's business. Refusing here would be the module overstepping.
  await service.prepareSetup({ selectedServiceIds: ["seerr"] });

  assert.deepEqual(saved.selectedServiceIds, ["seerr"]);
});

test("changing a port into a collision is refused", async () => {
  const service = profileService({
    settings: { ...BASE, selectedServiceIds: ["radarr", "sonarr"] }
  });

  await assert.rejects(
    () => service.patchServiceOverride("sonarr", { port: 7878 }),
    /both set to port 7878/
  );
});

test("an override that is not a port is never port-checked", async () => {
  // Cutover writes overrides describing a container that already exists.
  // Refusing to record reality would leave the dashboard lying about the host.
  let saved = null;
  const service = profileService({
    settings: { ...BASE, selectedServiceIds: ["radarr", "sonarr"], serviceOverrides: { sonarr: { port: 7878 } } },
    onSave: async (input) => { saved = input; return input; }
  });

  await service.patchServiceOverride("sonarr", { mode: "imported" });

  assert.equal(saved.serviceOverrides.sonarr.mode, "imported");
});

// --- over HTTP ---

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function withServer(run) {
  const app = createHttpApp({
    publicDir,
    keelarrApp: new DemoKeelarrAppService(),
    logger: silentLogger,
    requireAuth: false
  });
  const server = await startServer(app);

  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("the wizard endpoint answers with the catalog and what each choice would do", async () => {
  await withServer(async (base) => {
    const view = await (await fetch(`${base}/api/setup/wizard`)).json();

    assert.ok(view.catalog.length >= 13);
    assert.ok(view.catalog.every((entry) => ["install", "adopt", "managed"].includes(entry.action)));
    assert.ok(view.compatibility);
  });
});

test("compatibility can be asked about a selection that has not been saved", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/catalog/compatibility`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedServiceIds: ["radarr", "sonarr"],
        serviceOverrides: { sonarr: { port: 7878 } }
      })
    });
    const result = await response.json();

    // The point of the endpoint: a live answer about a hypothetical, with no
    // settings written and nothing installed.
    assert.equal(response.status, 200);
    assert.equal(result.ok, false);
    assert.equal(result.blocked[0].id, "port-collision");
  });
});

test("an empty compatibility request is answered, not rejected", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/catalog/compatibility`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  });
});
