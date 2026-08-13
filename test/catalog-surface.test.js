import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SERVICE_ORDER, SERVICE_CATALOG } from "../src/lib/service-catalog.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appJs = path.resolve(here, "..", "public", "app.js");

/**
 * The UI kept its own hardcoded list of service ids, so three services added to
 * the catalog were invisible in Settings and could not be installed at all —
 * and saving filtered the selection through that same list, silently dropping
 * anything missing from it.
 *
 * The fix was to derive the order from the catalog the controller sends. This
 * guards the fix: a literal list of ids in the front end is the bug returning.
 */
test("the front end does not keep its own copy of the catalog", async () => {
  const source = await readFile(appJs, "utf8");

  // An array literal holding several known service ids is the shape to catch.
  const arrays = source.match(/\[[^\]]*"(prowlarr|radarr|sonarr)"[^\]]*\]/g) || [];
  const duplicates = arrays.filter((block) => {
    const ids = SERVICE_ORDER.filter((id) => block.includes(`"${id}"`));
    return ids.length >= 3;
  });

  assert.deepEqual(
    duplicates,
    [],
    `the UI lists catalog ids itself; derive them from state.catalog instead:\n${duplicates.join("\n")}`
  );
});

test("every catalog service is orderable, so none can be hidden by ordering", () => {
  // SERVICE_ORDER is what the controller sends and therefore what the UI shows.
  // A service in the catalog but missing from the order would never render.
  const ordered = new Set(SERVICE_ORDER);
  const missing = Object.keys(SERVICE_CATALOG).filter((id) => !ordered.has(id));

  assert.deepEqual(missing, [], "these services exist in the catalog but are not in SERVICE_ORDER");
});

test("every ordered service actually exists in the catalog", () => {
  const missing = SERVICE_ORDER.filter((id) => !SERVICE_CATALOG[id]);

  assert.deepEqual(missing, [], "these ids are ordered but have no catalog entry");
});
