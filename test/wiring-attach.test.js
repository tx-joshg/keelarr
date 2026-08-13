import test from "node:test";
import assert from "node:assert/strict";

import { ENDPOINT_KIND } from "../src/lib/wiring/topology.js";
import { attachController, planControllerAttachments } from "../src/lib/wiring/attach.js";

const controller = (...networks) => ({
  serviceId: "keelarr",
  name: "Keelarr",
  running: true,
  kind: ENDPOINT_KIND.BRIDGE,
  networks: networks.map((name) => ({ name, address: "172.20.0.2", driver: "bridge" }))
});

const app = (name, kind, networks, running = true) => ({
  serviceId: name.toLowerCase(),
  name,
  running,
  kind,
  networks
});

const userBridge = (name) => [{ name, address: "172.29.0.2", driver: "bridge" }];

test("the controller joins the shared network even with nothing on it yet", () => {
  // This is what lets a clean host work with no manual setup: the controller's
  // Compose file declares no networks, so it starts on its own default bridge
  // and pulls itself onto the shared network here. Without this, the first
  // catalog service deployed would be unreachable until the next restart.
  const plan = planControllerAttachments(controller("deploy_default"), [], "keelarr");

  assert.deepEqual(plan, [{ network: "keelarr", services: [] }]);
});

test("the shared network is not joined twice when already attached", () => {
  const plan = planControllerAttachments(controller("keelarr"), [], "keelarr");

  assert.deepEqual(plan, []);
});

test("the controller joins a user-defined network it is missing", () => {
  const plan = planControllerAttachments(controller("keelarr"), [
    app("Ombi", ENDPOINT_KIND.BRIDGE, userBridge("ombi_default"))
  ]);

  assert.deepEqual(plan, [{ network: "ombi_default", services: ["Ombi"] }]);
});

test("nothing is joined for apps already reachable another way", () => {
  // Host networking and macvlan answer from anywhere on the host, and an app
  // already sharing a network needs nothing.
  const plan = planControllerAttachments(controller("keelarr"), [
    app("Radarr", ENDPOINT_KIND.HOST, [{ name: "host", address: null, driver: "host" }]),
    app("SABnzbd", ENDPOINT_KIND.MACVLAN, [{ name: "qnet", address: "198.51.100.10", driver: "qnet" }]),
    app("Prowlarr", ENDPOINT_KIND.BRIDGE, userBridge("keelarr"))
  ]);

  assert.deepEqual(plan, []);
});

test("a stopped app is not chased onto a network", () => {
  const plan = planControllerAttachments(controller("keelarr"), [
    app("Ombi", ENDPOINT_KIND.BRIDGE, userBridge("ombi_default"), false)
  ]);

  assert.deepEqual(plan, []);
});

test("apps sharing a network produce one attachment, not one each", () => {
  const plan = planControllerAttachments(controller("keelarr"), [
    app("Ombi", ENDPOINT_KIND.BRIDGE, userBridge("shared_default")),
    app("Trailarr", ENDPOINT_KIND.BRIDGE, userBridge("shared_default"))
  ]);

  assert.deepEqual(plan, [{ network: "shared_default", services: ["Ombi", "Trailarr"] }]);
});

test("a user-defined network is preferred over the default bridge", () => {
  // The default bridge carries no DNS, so joining it only buys an IP route.
  const plan = planControllerAttachments(controller("keelarr"), [
    app("Tautulli", ENDPOINT_KIND.BRIDGE, [
      { name: "bridge", address: "203.0.113.6", driver: "bridge" },
      { name: "tautulli_default", address: "172.29.4.2", driver: "bridge" }
    ])
  ]);

  assert.deepEqual(plan, [{ network: "tautulli_default", services: ["Tautulli"] }]);
});

test("the default bridge is still joined when it is the only option", () => {
  const plan = planControllerAttachments(controller("keelarr"), [
    app("Tautulli", ENDPOINT_KIND.BRIDGE, [{ name: "bridge", address: "203.0.113.6", driver: "bridge" }])
  ]);

  assert.deepEqual(plan, [{ network: "bridge", services: ["Tautulli"] }]);
});

test("an overlapping subnet is reported, and does not stop the remaining joins", async () => {
  const calls = [];
  const result = await attachController(
    { dockerBin: "docker" },
    [
      { network: "clashing_net", services: ["Ombi"] },
      { network: "fine_net", services: ["Trailarr"] }
    ],
    {
      runCommandImpl: async (_bin, args) => {
        calls.push(args[2]);
        return args[2] === "clashing_net"
          ? { ok: false, stderr: "Pool overlaps with other one on this address space", code: 1 }
          : { ok: true, stdout: "", stderr: "", code: 0 };
      }
    }
  );

  assert.deepEqual(calls, ["clashing_net", "fine_net"]);
  assert.deepEqual(result.attached, [{ network: "fine_net", services: ["Trailarr"] }]);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /overlaps an address range/);
  assert.match(result.skipped[0].reason, /container health only/);
});

test("an already-connected network is neither counted nor treated as a failure", async () => {
  const result = await attachController({ dockerBin: "docker" }, [{ network: "ombi_default", services: ["Ombi"] }], {
    runCommandImpl: async () => ({ ok: false, stderr: "endpoint with name keelarr already exists in ombi_default", code: 1 })
  });

  assert.deepEqual(result.attached, []);
  assert.deepEqual(result.skipped, []);
});
