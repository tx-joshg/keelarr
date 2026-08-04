import test from "node:test";
import assert from "node:assert/strict";

import { DemoStackarrAppService } from "../src/lib/demo-service.js";

test("demo service exposes a simulated dashboard state", async () => {
  const service = new DemoStackarrAppService();
  const state = await service.buildState();

  assert.equal(state.meta.mode, "demo");
  assert.equal(state.services.length > 0, true);
  assert.equal(state.services.every((item) => item.appUrl.startsWith("/demo/apps/")), true);
});

test("demo service can generate a managed draft from an import candidate", async () => {
  const service = new DemoStackarrAppService();
  const result = await service.adoptImportAsDraft("trailarrdemo");
  const scan = await service.scanImportInventory();

  assert.equal(result.ok, true);
  assert.equal(result.preview.target.serviceId, "trailarr");
  assert.equal(result.generated.serviceId, "trailarr");
  assert.match(result.generated.reviewSummaryPath, /import-summary\.json$/);
  assert.match(result.generated.reviewNotesPath, /IMPORT-REVIEW\.md$/);
  assert.equal(scan.items.find((item) => item.containerId === "trailarrdemo")?.adoptedDraft, true);
});
