#!/usr/bin/env node
/**
 * A stand-in for the `oc` binary, used to exercise the real command
 * construction in src/lib/runtimes/kube-runtime.js without a cluster.
 *
 * It proves the argv Keelarr builds and nothing more. A stub cannot tell you
 * whether a real OKD cluster accepts these manifests or whether its SCCs admit
 * the pod — see the note at the top of kube-runtime.js.
 *
 * State lives in the JSON file named by STUB_OC_STATE so each invocation sees
 * what the last one did, and every invocation is appended to `log`.
 */
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.STUB_OC_STATE;
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(statePath, "utf8"));

state.log.push(args.join(" "));
writeFileSync(statePath, JSON.stringify(state, null, 2));

function out(text = "") {
  if (text) {
    process.stdout.write(`${text}\n`);
  }
  process.exit(0);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// Every real call is namespaced; a command that forgot would be a bug worth
// catching here rather than against a cluster.
if (args[0] !== "-n") {
  fail("stub-oc: expected -n <namespace> first");
}

const rest = args.slice(2);
const [command] = rest;

if (state.failCommand && rest.join(" ").startsWith(state.failCommand)) {
  fail(state.failMessage || "stub-oc: forced failure");
}

if (command === "apply") {
  out("deployment.apps/radarr configured");
}

if (command === "rollout") {
  if (rest[1] === "status") {
    out(`deployment "${rest[2]}" successfully rolled out`);
  }

  if (rest[1] === "history") {
    out(state.rolloutHistory ?? "REVISION  CHANGE-CAUSE\n1         <none>\n2         <none>");
  }

  out("restarted");
}

if (command === "get" && rest[1] === "pods") {
  out(JSON.stringify(state.pods || { items: [] }));
}

if (command === "get" && rest[1] === "deployment") {
  out(JSON.stringify(state.deployment || { status: { readyReplicas: 1 } }));
}

if (command === "exec") {
  out(state.execOutput ?? "");
}

if (command === "logs") {
  out(state.logs ?? "");
}

if (command === "delete" || command === "scale") {
  out("ok");
}

fail(`stub-oc: unsupported command ${rest.join(" ")}`);
