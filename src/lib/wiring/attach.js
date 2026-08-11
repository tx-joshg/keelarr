import { runCommand } from "../command-runner.js";
import { ENDPOINT_KIND, clearControllerEndpointCache } from "./topology.js";

const DEFAULT_BRIDGE_NETWORK = "bridge";

/**
 * Works out which networks the controller should join to see its own services.
 *
 * The alternative — telling the operator to move their apps onto a shared
 * network so Stackarr can watch them — asks them to rearrange working
 * infrastructure to suit the monitoring. The controller is the under-connected
 * one, and it is the only container Stackarr owns, so it is the one that moves.
 *
 * Pure: returns the plan, attaches nothing.
 */
export function planControllerAttachments(controller, endpoints, sharedNetwork = null) {
  const joined = new Set((controller?.networks || []).map((network) => network.name));
  const plan = new Map();

  // The shared network is where catalog services land, so the controller joins
  // it whether or not anything is on it yet. This is what lets a clean host
  // work with no manual setup: the controller's own Compose file declares no
  // networks at all, and the first service deployed is reachable immediately
  // rather than after the next controller restart.
  if (sharedNetwork && !joined.has(sharedNetwork)) {
    plan.set(sharedNetwork, []);
  }

  for (const endpoint of endpoints) {
    if (!endpoint?.running) {
      continue;
    }

    // Host networking and macvlan are already reachable from anywhere on the
    // host; joining anything for them would be noise.
    if (endpoint.kind === ENDPOINT_KIND.HOST || endpoint.kind === ENDPOINT_KIND.MACVLAN) {
      continue;
    }

    if (endpoint.networks.some((network) => joined.has(network.name))) {
      continue;
    }

    // A user-defined bridge is worth more than the default one: it carries DNS,
    // so the app resolves by container name and survives its address changing.
    const candidate =
      endpoint.networks.find((network) => network.name !== DEFAULT_BRIDGE_NETWORK && network.driver === "bridge") ||
      endpoint.networks.find((network) => network.name === DEFAULT_BRIDGE_NETWORK);

    if (!candidate) {
      continue;
    }

    if (!plan.has(candidate.name)) {
      plan.set(candidate.name, []);
    }

    plan.get(candidate.name).push(endpoint.name);
  }

  return [...plan].map(([network, services]) => ({ network, services }));
}

/**
 * Joins the controller to each planned network.
 *
 * Additive and reversible: `docker network connect` adds an interface to the
 * running container without recreating or restarting it, and touches nothing
 * belonging to the services being watched.
 *
 * Idempotent by design, so it can run on every start — which is what makes it
 * survive the controller being recreated, since the attachment itself is not
 * recorded in any Compose file.
 */
export async function attachController(settings, plan, options = {}) {
  const run = options.runCommandImpl || runCommand;
  const containerName = options.containerName || "stackarr";
  const attached = [];
  const skipped = [];

  for (const entry of plan) {
    const result = await run(settings.dockerBin, ["network", "connect", entry.network, containerName], {
      logger: options.logger
    });

    if (result.ok) {
      attached.push(entry);
      continue;
    }

    const message = String(result.stderr || result.error || "");

    if (/already exists|already connected/i.test(message)) {
      continue;
    }

    // Overlapping address ranges are the realistic failure: two networks that
    // both want the same subnet cannot both be joined. Reporting which apps go
    // unwatched beats leaving the controller wedged mid-attach.
    skipped.push({
      network: entry.network,
      services: entry.services,
      reason: /pool overlaps|address space/i.test(message)
        ? `The ${entry.network} network overlaps an address range Stackarr is already using, so it cannot join. ${entry.services.join(" and ")} will be reported by container health only.`
        : `Stackarr could not join ${entry.network}: ${message.trim() || "the daemon refused the request."}`
    });
  }

  if (attached.length > 0) {
    // The cached endpoint describes the controller's old attachments.
    clearControllerEndpointCache();
  }

  return { attached, skipped };
}
