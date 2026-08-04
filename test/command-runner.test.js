import test from "node:test";
import assert from "node:assert/strict";

import { runCommand } from "../src/lib/command-runner.js";

test("runCommand returns a failed result when the binary is missing", async () => {
  const result = await runCommand("/definitely-not-stackarr/docker", ["version"]);

  assert.equal(result.ok, false);
  assert.equal(result.code, null);
  assert.match(result.stderr, /ENOENT|not found/i);
});
