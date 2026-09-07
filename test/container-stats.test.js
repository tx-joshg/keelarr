import test from "node:test";
import assert from "node:assert/strict";

import {
  clearContainerStatsCache,
  scanDockerInventory,
  settleContainerStats
} from "../src/lib/import-scanner.js";

const CONTAINER = {
  Id: "abc123def456",
  Name: "/radarr",
  State: { Running: true, Status: "running", StartedAt: "2026-08-01T00:00:00.000Z" },
  Config: { Image: "lscr.io/linuxserver/radarr:latest", Env: [], Labels: {} },
  HostConfig: { NetworkMode: "host", RestartPolicy: { Name: "unless-stopped" } },
  NetworkSettings: { Networks: {}, Ports: {} },
  Mounts: [],
  Image: "sha256:image"
};

const STATS_LINE = '{"CPUPerc":"2.35%","ID":"abc123def456","MemPerc":"3.97%","MemUsage":"311.5MiB / 7.663GiB","Name":"radarr"}';

/**
 * Stands in for `docker stats`, which really does take ~2s on a NAS whatever
 * you ask it for. `delayMs` makes that cost visible to the test.
 */
function createDocker({ delayMs = 0, statsLine = STATS_LINE, failStats = false } = {}) {
  const calls = [];

  return {
    calls,
    runCommand: async (_bin, args) => {
      calls.push(args[0]);

      if (args[0] === "stats") {
        if (delayMs) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }

        return failStats
          ? { ok: false, stdout: "", stderr: "daemon busy", code: 1 }
          : { ok: true, stdout: statsLine, stderr: "", code: 0 };
      }

      if (args[0] === "ps") {
        return { ok: true, stdout: CONTAINER.Id, stderr: "", code: 0 };
      }

      if (args[0] === "inspect") {
        return { ok: true, stdout: JSON.stringify([CONTAINER]), stderr: "", code: 0 };
      }

      return { ok: true, stdout: "[]", stderr: "", code: 0 };
    }
  };
}

async function scan(docker, overrides = {}) {
  return scanDockerInventory(
    { dockerBin: "docker" },
    { runCommandImpl: docker.runCommand, ...overrides }
  );
}

test("a refresh does not wait for docker stats, even when stats is slow", async (t) => {
  clearContainerStatsCache();
  t.after(clearContainerStatsCache);

  const docker = createDocker({ delayMs: 2000 });
  const startedAt = Date.now();
  await scan(docker);
  const elapsed = Date.now() - startedAt;

  // The whole point: a two-second sample must not become a two-second page.
  assert.ok(elapsed < 500, `refresh blocked for ${elapsed}ms`);
  await settleContainerStats();
});

test("the first refresh reports no usage, and the next one has it", async (t) => {
  clearContainerStatsCache();
  t.after(clearContainerStatsCache);

  const docker = createDocker();

  const first = await scan(docker);
  assert.equal(first.items[0].resourceUsage, null, "cold start should not block to fill this in");

  await settleContainerStats();

  const second = await scan(docker);
  assert.equal(second.items[0].resourceUsage.cpuPercentDisplay, "2.35%");
});

test("stale numbers keep being served while a fresh sample is in flight", async (t) => {
  clearContainerStatsCache();
  t.after(clearContainerStatsCache);

  let clock = 1_000_000;
  const docker = createDocker({ delayMs: 50 });

  await scan(docker, { nowImpl: () => clock });
  await settleContainerStats();

  // Push past the freshness window so the next scan triggers a background
  // sample, and confirm it still answers with the numbers it already had.
  clock += 60_000;
  const stale = await scan(docker, { nowImpl: () => clock });

  assert.equal(stale.items[0].resourceUsage.cpuPercentDisplay, "2.35%");
  await settleContainerStats();
});

test("only one sample runs at a time no matter how many refreshes arrive", async (t) => {
  clearContainerStatsCache();
  t.after(clearContainerStatsCache);

  const docker = createDocker({ delayMs: 100 });

  await Promise.all([scan(docker), scan(docker), scan(docker), scan(docker)]);
  await settleContainerStats();

  // Four refreshes, one `docker stats`. Without the in-flight guard each one
  // would start its own two-second sample.
  assert.equal(docker.calls.filter((call) => call === "stats").length, 1);
});

test("a failed sample leaves the inventory usable rather than failing the refresh", async (t) => {
  clearContainerStatsCache();
  t.after(clearContainerStatsCache);

  const docker = createDocker({ failStats: true });
  const result = await scan(docker);
  await settleContainerStats();

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].resourceUsage, null);
  assert.equal(result.items[0].containerName, "radarr");
});

test("the inventory keeps the container's start time and restart count", async (t) => {
  clearContainerStatsCache();
  t.after(clearContainerStatsCache);

  const inspectWith = (State, RestartCount) => async (_bin, args) => {
    if (args[0] === "ps") return { ok: true, stdout: CONTAINER.Id, stderr: "", code: 0 };
    // `docker inspect <container>` and `docker image inspect <ref>` both start
    // with "inspect" after the subcommand; only the container one carries State.
    if (args[0] === "inspect") return { ok: true, stdout: JSON.stringify([{ ...CONTAINER, State, RestartCount }]), stderr: "", code: 0 };
    if (args[0] === "stats") return { ok: true, stdout: STATS_LINE, stderr: "", code: 0 };
    return { ok: true, stdout: "[]", stderr: "", code: 0 };
  };

  const started = await scanDockerInventory({ dockerBin: "docker" }, {
    runCommandImpl: inspectWith({ Running: true, Status: "running", StartedAt: "2026-08-01T00:00:00.000Z" }, 3)
  });
  assert.equal(started.items[0].startedAt, "2026-08-01T00:00:00.000Z");
  assert.equal(started.items[0].restartCount, 3);

  // Docker's "never started" sentinel is not a start time.
  const never = await scanDockerInventory({ dockerBin: "docker" }, {
    runCommandImpl: inspectWith({ Running: true, Status: "running", StartedAt: "0001-01-01T00:00:00Z" }, undefined)
  });
  assert.equal(never.items[0].startedAt, null);
  assert.equal(never.items[0].restartCount, 0);
  await settleContainerStats();
});
