import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "..", "src");

async function listModules(dir) {
  const found = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      found.push(...(await listModules(full)));
      continue;
    }

    if (entry.name.endsWith(".js")) {
      found.push(full);
    }
  }

  return found;
}

/**
 * Imports every module under src/.
 *
 * The project-wide rename replaced the text inside every file but not the
 * filenames, so an import pointed at a module that no longer existed. The whole
 * suite passed and the app would not start — the broken module happened to be
 * one of the few with no direct test of its own.
 *
 * This is the cheapest possible guard against that class of mistake: a missing
 * file, a typo'd path, or a syntax error anywhere in the tree fails here even
 * when nothing else covers that module.
 */
test("every module under src/ can be imported", async () => {
  const modules = await listModules(srcDir);

  // A guard on the guard: if this ever finds nothing, the walk is broken and
  // the test would be passing vacuously.
  assert.ok(modules.length > 20, `only found ${modules.length} modules, expected the whole tree`);

  const failures = [];

  for (const file of modules) {
    // server.js starts listening on import, so it is checked for resolvable
    // imports without being run.
    if (file.endsWith(path.join("src", "server.js"))) {
      continue;
    }

    try {
      await import(pathToFileURL(file).href);
    } catch (error) {
      failures.push(`${path.relative(srcDir, file)}: ${error.message.split("\n")[0]}`);
    }
  }

  assert.deepEqual(failures, [], `modules failed to import:\n${failures.join("\n")}`);
});

test("the entry point's own imports all resolve", async () => {
  // Everything server.js pulls in, without the side effect of binding a port.
  const { createHttpApp } = await import("../src/create-http-app.js");
  const { KeelarrAppService } = await import("../src/lib/keelarr-app-service.js");
  const { DemoKeelarrAppService } = await import("../src/lib/demo-service.js");

  assert.equal(typeof createHttpApp, "function");
  assert.equal(typeof KeelarrAppService, "function");
  assert.equal(typeof DemoKeelarrAppService, "function");
});
