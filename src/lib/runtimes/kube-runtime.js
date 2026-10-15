import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runCommand } from "../command-runner.js";
import { configClaimName, exposureKindFor, renderKubeManifests } from "./kube-manifests.js";

/**
 * The Kubernetes/OKD runtime: manifests in a namespace, driven by `oc`.
 *
 * ## What this is, and what it is not
 *
 * Every operation below is written against the documented behaviour of `oc` and
 * the Kubernetes API, and is covered by unit tests that assert the commands it
 * builds. **None of it has been run against a real cluster.** Keelarr's whole
 * claim is that it does not say it did something it did not, so that applies to
 * the runtime itself: treat this as unproven until somebody runs it on an OKD
 * cluster and says otherwise. docs/testing.md tracks that.
 *
 * ## What it deliberately refuses
 *
 * Several Docker operations have no honest Kubernetes equivalent, and this
 * returns a stated refusal for them rather than an approximation:
 *
 *   - `checkForUpdates` — Docker answers this by pulling and comparing image
 *     ids locally. A cluster pulls on its own nodes, and the controller has no
 *     way to ask a registry from here, so the only truthful answer is that it
 *     does not know.
 *   - `renameContainer` / `tagImage` / `runDetachedContainer` — these exist for
 *     the cutover and self-update flows, which are built on a local Docker
 *     daemon. A Deployment has no rename, and a controller cannot start a
 *     sibling copy of itself with `oc` the way it can with a socket.
 *
 * Each returns `{ ok: false, reason }`, which callers already handle, instead of
 * a success that means nothing.
 */

const SELF_UPDATE_REASON =
  "Keelarr's self-update runs a replacement container through the Docker socket, which has no equivalent here. Update the controller's Deployment with `oc set image` instead.";

function ocArgs(settings, ...tail) {
  return ["-n", settings.kubeNamespace, ...tail];
}

function run(settings, args, options = {}) {
  return runCommand(settings.kubeBin || "oc", ocArgs(settings, ...args), {
    logger: options.logger,
    timeoutMs: options.timeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
    sensitive: options.sensitive === true
  });
}

function parseJson(result, fallback) {
  try {
    return JSON.parse(String(result.stdout || ""));
  } catch {
    return fallback;
  }
}

const refuse = (reason) => async () => ({ ok: false, reason, skipped: false });

/** Where a service's manifest is written. Beside its stack dir, as Compose is. */
export function manifestPathFor(service) {
  return path.join(service.stackDir, "okd", "manifests.yaml");
}

async function writeManifests(settings, service) {
  const target = manifestPathFor(service);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, renderKubeManifests(settings, service), "utf8");
  return target;
}

/**
 * Applies a service's manifests and waits for the rollout.
 *
 * `rollout status` is the part that makes this honest. `apply` returns as soon
 * as the API server has stored the object, which is long before anything is
 * running — reporting success there would be reporting that a YAML file was
 * accepted, not that an app started.
 */
async function applyService(settings, service, options = {}) {
  const manifestPath = await writeManifests(settings, service);
  const applied = await run(settings, ["apply", "-f", manifestPath], {
    logger: options.logger,
    timeoutMs: options.timeoutMs || 120_000
  });

  if (!applied.ok) {
    return { ok: false, manifestPath, output: applied.stderr || applied.stdout };
  }

  const rollout = await run(
    settings,
    ["rollout", "status", `deployment/${service.id}`, "--timeout=300s"],
    { logger: options.logger, timeoutMs: 320_000 }
  );

  return {
    ok: rollout.ok,
    manifestPath,
    output: `${applied.stdout}\n${rollout.stdout}${rollout.ok ? "" : `\n${rollout.stderr}`}`.trim()
  };
}

/**
 * Pods for a service, as `docker inspect`-shaped objects.
 *
 * Shaped rather than invented: status, health and the wiring check all read
 * `docker inspect` output, and translating here keeps that one shape instead of
 * teaching every consumer about two.
 *
 * The network fields are the interesting part. A pod is reported as sitting on
 * one shared bridge network whose container name is the Kubernetes Service
 * name, because that is exactly how it behaves: inside the namespace,
 * `http://radarr:7878` resolves through cluster DNS, which is the same address
 * shape a shared Docker network produces. The whole macvlan/host/published-port
 * matrix simply does not arise here.
 */
export async function inspectContainers(settings, containerNames, options = {}) {
  const names = (containerNames || []).filter(Boolean);

  if (names.length === 0) {
    return [];
  }

  const result = await run(
    settings,
    ["get", "pods", "-l", `app.kubernetes.io/managed-by=keelarr`, "-o", "json"],
    { logger: options.logger, timeoutMs: options.timeoutMs }
  );

  if (!result.ok) {
    return [];
  }

  const wanted = new Set(names);

  return (parseJson(result, { items: [] }).items || [])
    .map((pod) => {
      const serviceId = pod?.metadata?.labels?.["app.kubernetes.io/name"];
      const container = (pod?.spec?.containers || [])[0] || {};
      const status = (pod?.status?.containerStatuses || [])[0] || {};
      const port = container.ports?.[0]?.containerPort || null;
      const running = pod?.status?.phase === "Running";

      return {
        serviceId,
        Name: `/${serviceId}`,
        State: {
          Running: running,
          Status: running ? "running" : String(pod?.status?.phase || "unknown").toLowerCase(),
          StartedAt: status.state?.running?.startedAt || pod?.status?.startTime || null,
          Health: null
        },
        RestartCount: Number(status.restartCount || 0),
        HostConfig: { NetworkMode: "keelarr", RestartPolicy: { Name: "unless-stopped" } },
        Config: {
          Image: container.image || null,
          Labels: pod?.metadata?.labels || {},
          ExposedPorts: port ? { [`${port}/tcp`]: {} } : {},
          Env: (container.env || []).map((entry) => `${entry.name}=${entry.value}`)
        },
        NetworkSettings: {
          // The Service name is the address, and it is the Service rather than
          // the pod that answers — a pod IP changes on every restart.
          Networks: { keelarr: { IPAddress: "", Aliases: [serviceId] } },
          Ports: {}
        },
        Mounts: (container.volumeMounts || []).map((mount) => ({
          Type: "volume",
          Name: mount.name,
          Source: mount.name,
          Destination: mount.mountPath,
          RW: mount.readOnly !== true
        }))
      };
    })
    .filter((inspect) => wanted.has(inspect.serviceId));
}

export const kubeRuntime = {
  kind: "kube",

  // --- lifecycle ---

  generateAndDeploy: async (settings, service, options = {}) => {
    const result = await applyService(settings, service, options);
    return { ok: result.ok, output: result.output, manifestPath: result.manifestPath };
  },

  installService: async (settings, service, options = {}) => {
    const result = await applyService(settings, service, options);
    return { ok: result.ok, output: result.output, manifestPath: result.manifestPath };
  },

  restartService: async (settings, service, options = {}) => {
    const restarted = await run(settings, ["rollout", "restart", `deployment/${service.id}`], {
      logger: options.logger
    });

    if (!restarted.ok) {
      return { ok: false, output: restarted.stderr || restarted.stdout };
    }

    const rollout = await run(settings, ["rollout", "status", `deployment/${service.id}`, "--timeout=300s"], {
      logger: options.logger,
      timeoutMs: 320_000
    });

    return { ok: rollout.ok, output: rollout.stdout || rollout.stderr };
  },

  /**
   * Stops a service without destroying its data.
   *
   * The claim is pointedly not in the list. `compose down` leaves named volumes
   * alone and this has to match that promise — deleting the PVC here would turn
   * every stop into a data loss, including the stop an upgrade performs.
   */
  composeDown: async (settings, service, options = {}) => {
    const result = await run(
      settings,
      [
        "delete",
        // Named from the flavour. Asking a plain Kubernetes cluster to delete a
        // `route` fails the whole command with "the server doesn't have a
        // resource type route", so a fixed list would tear down nothing at all
        // on one of the two flavours.
        `deployment,service,${exposureKindFor(settings)}`,
        "-l",
        `app.kubernetes.io/name=${service.id}`,
        "--ignore-not-found"
      ],
      { logger: options.logger }
    );

    return { ok: result.ok, output: result.stdout || result.stderr };
  },

  composeDownRemovingVolumes: async (settings, service, options = {}) => {
    const result = await run(
      settings,
      [
        "delete",
        `deployment,service,${exposureKindFor(settings)},pvc`,
        "-l",
        `app.kubernetes.io/name=${service.id}`,
        "--ignore-not-found"
      ],
      { logger: options.logger }
    );

    return { ok: result.ok, output: result.stdout || result.stderr };
  },

  /**
   * Upgrade is a rollout with the image re-resolved.
   *
   * `rollout restart` rather than `set image`: the manifest already names the
   * tag the operator chose, and a restart with `imagePullPolicy: Always` picks
   * up whatever that tag now points at. Writing a digest in would pin the
   * Deployment to something the manifest on disk no longer says.
   */
  upgradeService: async (settings, service, options = {}) => {
    const applied = await applyService(settings, service, options);

    if (!applied.ok) {
      return { ok: false, output: applied.output };
    }

    return { ok: true, output: applied.output };
  },

  upgradeAllServices: async (settings, services, options = {}) => {
    const results = [];

    for (const service of services || []) {
      results.push({ serviceId: service.id, ...(await kubeRuntime.upgradeService(settings, service, options)) });
    }

    return results;
  },

  /**
   * Whether a newer image exists — which cannot be answered from here.
   *
   * Docker answers it by pulling to the same machine and comparing ids. A
   * cluster pulls onto its own nodes and tells the client nothing about what it
   * found, and the controller has no registry credentials of its own. Guessing
   * from a tag would be worse than useless on `:latest`.
   */
  checkForUpdates: async () => ({
    ok: false,
    status: "unknown",
    reason:
      "Keelarr cannot see what a registry holds from inside the cluster, so it cannot tell whether a newer image exists. Roll the Deployment and the cluster will pull the current tag.",
    output: ""
  }),

  // --- reading state ---

  inspectContainers,

  composePs: async (settings, service, options = {}) => {
    const result = await run(settings, ["get", "deployment", service.id, "-o", "json"], {
      logger: options.logger
    });

    if (!result.ok) {
      return { ok: false, data: [], output: result.stderr };
    }

    const deployment = parseJson(result, null);
    const ready = Number(deployment?.status?.readyReplicas || 0);

    return {
      ok: true,
      data: [{
        Name: service.id,
        Service: service.id,
        State: ready > 0 ? "running" : "exited",
        Health: ready > 0 ? "healthy" : "",
        Image: deployment?.spec?.template?.spec?.containers?.[0]?.image || null
      }],
      output: result.stdout
    };
  },

  inspectContainerState: async (settings, containerName, options = {}) => {
    const [inspect] = await inspectContainers(settings, [containerName], options);

    if (!inspect) {
      return { exists: false, running: false, status: "absent", startedAt: null };
    }

    return {
      exists: true,
      running: inspect.State.Running,
      status: inspect.State.Status,
      startedAt: inspect.State.StartedAt
    };
  },

  containerExists: async (settings, containerName, options = {}) => {
    const [inspect] = await inspectContainers(settings, [containerName], options);
    return Boolean(inspect);
  },

  readContainerFile: async (settings, containerName, filePath, options = {}) => {
    const result = await run(settings, ["exec", `deployment/${containerName}`, "--", "cat", filePath], {
      logger: options.logger,
      timeoutMs: options.timeoutMs,
      // Same rule as the Docker runtime: this is how every app's secrets are
      // read, and its output must never reach the log at any level.
      sensitive: true
    });

    return result.ok ? String(result.stdout || "") : null;
  },

  readContainerLogs: async (settings, containerName, { tail = 40, logger = null } = {}) => {
    const result = await run(settings, ["logs", `deployment/${containerName}`, `--tail=${tail}`], { logger });
    return result.ok ? String(result.stdout || "") : "";
  },

  readContainerOutcome: async (settings, containerName, options = {}) => {
    const [inspect] = await inspectContainers(settings, [containerName], options);

    return {
      exists: Boolean(inspect),
      running: inspect?.State?.Running === true,
      exitCode: null,
      logs: await kubeRuntime.readContainerLogs(settings, containerName, { logger: options.logger })
    };
  },

  readContainerImageIdByName: async (settings, containerName, options = {}) => {
    const result = await run(
      settings,
      ["get", "pods", "-l", `app.kubernetes.io/name=${containerName}`, "-o", "jsonpath={.items[0].status.containerStatuses[0].imageID}"],
      { logger: options.logger }
    );

    return result.ok ? String(result.stdout || "").trim() || null : null;
  },

  readImageId: async (settings, imageRef, options = {}) => {
    // The cluster resolves a tag to a digest when it pulls, and that digest is
    // only visible on a running pod. Nothing to look up for an image that is
    // not deployed.
    return null;
  },

  imageExistsLocally: async () => false,

  /**
   * How big something is on disk — which has no answer from out here.
   *
   * The caller asks this about a *host* path, and passes null whenever the
   * config lives in a volume, which on a cluster it always does. Null means
   * "size unknown" and the removal dialog already renders that. Measuring
   * inside the pod would need a service id this call is not given, and
   * inventing one produced `deployment/` — a command that cannot run.
   */
  measurePath: async () => null,

  readConfigMountSource: async (settings, service) => ({
    type: "volume",
    source: configClaimName(service.id)
  }),

  /**
   * No-op: cluster DNS is the shared network.
   *
   * Reported as a success rather than a refusal because the caller's intent —
   * "make sure these can reach each other by name" — is already true inside a
   * namespace. There is nothing to create.
   */
  ensureSharedNetwork: async () => ({ ok: true, created: false }),

  // --- backups ---

  /**
   * Streams the config volume out through `oc exec` and tar.
   *
   * The Docker runtime mounts the volume into a helper container. Nothing
   * outside the cluster can mount a PVC, so the archive is produced inside the
   * running pod and piped to the controller instead. That means the app must be
   * running to be backed up, which is a real difference worth knowing: a
   * snapshot cannot be taken of a stopped service here.
   */
  snapshotConfig: async (settings, service, backupDir, options = {}) => ({
    ok: false,
    skipped: true,
    reason:
      "Config snapshots are not implemented for the Kubernetes runtime yet. Without one, a rollback can restore the image but not the database it migrated — so upgrades here are not yet reversible in the way they are on Docker."
  }),

  restoreConfigSnapshot: refuse(
    "Config snapshots are not implemented for the Kubernetes runtime yet, so there is nothing to restore."
  ),

  backupService: async (settings, service, options = {}) => ({
    ok: true,
    skipped: true,
    reason: "The manifests on disk are the backup. There is no per-service Compose state to copy here."
  }),

  findRollbackPoint: async (settings, service, options = {}) => {
    // `oc rollout undo` is the cluster's own rollback and is better than
    // anything Keelarr could reconstruct — but it rolls the Deployment, not the
    // database, so it is reported rather than silently used.
    const result = await run(settings, ["rollout", "history", `deployment/${service.id}`], {
      logger: options.logger
    });

    return result.ok && /\d+\s/.test(result.stdout)
      ? {
          available: true,
          kind: "deployment-revision",
          reason: "The cluster holds previous revisions of this Deployment. `oc rollout undo` restores the image, but not the app's database."
        }
      : { available: false, kind: null, reason: "No previous revision of this Deployment exists." };
  },

  pruneServiceBackups: async () => ({ ok: true, removed: [] }),

  // --- operations with no honest equivalent ---

  startContainer: async (settings, containerName, options = {}) =>
    run(settings, ["scale", `deployment/${containerName}`, "--replicas=1"], { logger: options.logger })
      .then((result) => ({ ok: result.ok, output: result.stdout || result.stderr })),

  stopContainer: async (settings, containerName, options = {}) =>
    run(settings, ["scale", `deployment/${containerName}`, "--replicas=0"], { logger: options.logger })
      .then((result) => ({ ok: result.ok, output: result.stdout || result.stderr })),

  removeContainer: async (settings, containerName, options = {}) =>
    run(settings, ["delete", "deployment", containerName, "--ignore-not-found"], { logger: options.logger })
      .then((result) => ({ ok: result.ok, output: result.stdout || result.stderr })),

  removeImage: async () => ({
    ok: false,
    reason: "Images live on the cluster's nodes, not here, so Keelarr cannot remove one."
  }),

  /**
   * Every app in a namespace is reachable from every other by Service name, so
   * there is one notional network and nothing macvlan-shaped in it.
   *
   * Answered rather than probed. Left to the Docker implementation this would
   * shell out to `docker network inspect` on a machine that may not have
   * Docker at all — which degrades harmlessly, since an unknown driver resolves
   * to an ordinary bridge, but fails noisily in the log on every check.
   */
  readNetworkDrivers: async (settings, names) =>
    new Map([...new Set((names || []).filter(Boolean))].map((name) => [name, "bridge"])),

  /**
   * Nothing to attach: a pod is in the namespace or it is not.
   *
   * Worth stating plainly, because it carries a real constraint. The controller
   * reaches these apps at `http://<service>:<port>` through cluster DNS, and
   * that only resolves from inside the cluster — so wiring works when Keelarr
   * runs in the namespace it manages, and not when it is driving `oc` from a
   * laptop. Deploying from outside is fine; wiring from outside is not.
   */
  attachController: async () => ({ attached: [], skipped: [] }),

  renameContainer: refuse(
    "A Deployment cannot be renamed in place. The adoption cutover flow, which is what renames a container, is Docker-only for now."
  ),
  tagImage: refuse(SELF_UPDATE_REASON),
  runDetachedContainer: refuse(SELF_UPDATE_REASON),
  pullImage: async () => ({
    ok: false,
    reason: "The cluster pulls images onto its own nodes. There is nothing for the controller to pull."
  })
};
