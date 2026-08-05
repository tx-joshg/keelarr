import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRollbackRecord,
  deriveUpdateStatusFromPullResult,
  normalizeComposePsData,
  normalizeImageId
} from "../src/lib/runtime.js";

test("normalizeComposePsData preserves array payloads", () => {
  const payload = [{ Name: "trailarr", State: "running" }];

  assert.deepEqual(normalizeComposePsData(payload), payload);
});

test("normalizeComposePsData wraps single-object payloads from one-service compose projects", () => {
  const payload = { Name: "trailarr", State: "running" };

  assert.deepEqual(normalizeComposePsData(payload), [payload]);
});

test("normalizeComposePsData falls back to an empty list for nullish payloads", () => {
  assert.deepEqual(normalizeComposePsData(null), []);
  assert.deepEqual(normalizeComposePsData(undefined), []);
});

test("normalizeImageId trims whitespace and returns null for empty values", () => {
  assert.equal(normalizeImageId(" sha256:abc123 \n"), "sha256:abc123");
  assert.equal(normalizeImageId(""), null);
});

test("deriveUpdateStatusFromPullResult marks a pulled image as current when the running image id matches", () => {
  const status = deriveUpdateStatusFromPullResult("trailarr Pulling\ntrailarr Pulled", "sha256:same", "sha256:same");

  assert.equal(status, "current");
});

test("deriveUpdateStatusFromPullResult marks a pulled image as ready when the running image id differs", () => {
  const status = deriveUpdateStatusFromPullResult("trailarr Pulling\ntrailarr Pulled", "sha256:old", "sha256:new");

  assert.equal(status, "ready");
});

test("buildRollbackRecord pins the running image id rather than the mutable tag", () => {
  const record = buildRollbackRecord({
    id: "trailarr",
    containerName: "trailarr",
    image: "nandyalu/trailarr:latest"
  }, {
    imageId: "sha256:old",
    imageRepoDigest: "nandyalu/trailarr@sha256:olddigest",
    backedUpAt: "2026-08-05T00:00:00.000Z"
  });

  assert.deepEqual(record, {
    serviceId: "trailarr",
    containerName: "trailarr",
    image: "nandyalu/trailarr:latest",
    imageId: "sha256:old",
    imageRepoDigest: "nandyalu/trailarr@sha256:olddigest",
    backedUpAt: "2026-08-05T00:00:00.000Z"
  });
});

test("buildRollbackRecord degrades to nulls when the image identity cannot be read", () => {
  const record = buildRollbackRecord({
    id: "ombi",
    containerName: "ombi"
  }, {
    imageId: null,
    imageRepoDigest: null,
    backedUpAt: "2026-08-05T00:00:00.000Z"
  });

  assert.equal(record.image, null);
  assert.equal(record.imageId, null);
  assert.equal(record.imageRepoDigest, null);
});
