#!/usr/bin/env node
/**
 * A stand-in for the `docker` binary, used to exercise the real command
 * construction in src/lib/runtime.js without a Docker daemon.
 *
 * State lives in the JSON file named by STUB_DOCKER_STATE so each spawned
 * invocation sees the mutations made by the previous one, exactly as the real
 * CLI would. Every invocation is appended to `log` so tests can assert the
 * exact argv sequence Keelarr produced.
 */
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.STUB_DOCKER_STATE;
const args = process.argv.slice(2);

const state = JSON.parse(readFileSync(statePath, "utf8"));
state.log.push(args.join(" "));

function save() {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function fail(message) {
  save();
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function succeed(output = "") {
  save();
  if (output) {
    process.stdout.write(`${output}\n`);
  }
  process.exit(0);
}

function containerNameFromCompose(composePath) {
  const text = readFileSync(composePath, "utf8");
  return text.match(/container_name:\s*(\S+)/)?.[1] || null;
}

const [command] = args;

if (command === "inspect") {
  const name = args[1];
  const formatIndex = args.indexOf("--format");
  const container = state.containers[name];

  if (!container) {
    fail(`Error: No such object: ${name}`);
  }

  if (formatIndex === -1) {
    succeed(JSON.stringify([{ Name: `/${name}`, State: { Status: container.status } }], null, 2));
  }

  const format = args[formatIndex + 1];

  if (format === "{{.Id}}") {
    succeed(`sha256:container-${name}`);
  }

  if (format === "{{.Image}}") {
    succeed(container.imageId);
  }

  if (format === "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}") {
    succeed(`${container.status}|${container.health || ""}`);
  }

  fail(`stub-docker: unsupported inspect format ${format}`);
}

if (command === "image") {
  const format = args[args.indexOf("--format") + 1];

  if (format === "{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}") {
    succeed(state.repoDigest || "");
  }

  succeed("sha256:tagged-image");
}

if (command === "stop") {
  const container = state.containers[args[1]];

  if (!container) {
    fail(`Error response from daemon: No such container: ${args[1]}`);
  }

  container.status = "exited";
  succeed(args[1]);
}

if (command === "start") {
  const container = state.containers[args[1]];

  if (!container) {
    fail(`Error response from daemon: No such container: ${args[1]}`);
  }

  container.status = "running";
  succeed(args[1]);
}

if (command === "rename") {
  const [, from, to] = args;

  if (!state.containers[from]) {
    fail(`Error response from daemon: No such container: ${from}`);
  }

  if (state.containers[to]) {
    fail(`Error response from daemon: conflict: name ${to} is already in use`);
  }

  state.containers[to] = state.containers[from];
  delete state.containers[from];
  succeed();
}

if (command === "compose") {
  const composePath = args[args.indexOf("-f") + 1];
  const action = args.includes("up") ? "up" : args.includes("down") ? "down" : null;
  const name = containerNameFromCompose(composePath);

  if (action === "up") {
    if (state.failComposeUp) {
      fail(`Error response from daemon: driver failed programming external connectivity`);
    }

    // The real CLI refuses to reuse a name held by another container.
    if (state.containers[name]) {
      fail(`Error response from daemon: Conflict. The container name "/${name}" is already in use`);
    }

    state.containers[name] = {
      status: "running",
      health: state.composedHealth ?? "healthy",
      imageId: "sha256:new-image",
      composeManaged: true
    };
    succeed(`Container ${name}  Started`);
  }

  if (action === "down") {
    delete state.containers[name];
    succeed(`Container ${name}  Removed`);
  }

  fail(`stub-docker: unsupported compose action in ${args.join(" ")}`);
}

fail(`stub-docker: unsupported command ${args.join(" ")}`);
