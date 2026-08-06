import { createLogger } from "../logger.js";
import { loadSettings } from "../store.js";
import { inspectContainers } from "../runtime.js";
import { arrApi, speaksArrApi } from "../wiring/app-clients.js";
import { hasReadableApiKey, readApiKey } from "../wiring/api-keys.js";
import { buildEndpoint, inspectNetworkDrivers, isStillStarting, resolveLink } from "../wiring/topology.js";
import { planPathMapping, planRootFolder, readMounts } from "../wiring/path-plan.js";
import {
  RECONCILE_STATE,
  reconcileApplication,
  reconcileDownloadClient,
  reconcileRootFolder
} from "../wiring/reconcile.js";
import { getServiceDefinition } from "../service-catalog.js";

const defaultLogger = createLogger();

/** Apps that acquire releases and therefore need a download client. */
const ACQUIRERS = ["radarr", "sonarr", "lidarr"];

/** How each acquirer identifies itself to Prowlarr. */
const PROWLARR_IMPLEMENTATION = { radarr: "Radarr", sonarr: "Sonarr", lidarr: "Lidarr" };

const READINESS = Object.freeze({
  READY: "ready",
  INCOMPLETE: "incomplete",
  BLOCKED: "blocked",
  PENDING: "pending"
});

function hostAddressFrom(settings) {
  try {
    return new URL(settings.hostUrl).hostname;
  } catch {
    return null;
  }
}

/**
 * Explicit projection rather than a spread.
 *
 * An Arr's download-client response carries the download client's own API key
 * in `fields[].value`, so passing a fetched object through to the response
 * would publish SABnzbd's key on `/api/wiring/check`.
 */
function describeDownloadClient(client) {
  if (!client) {
    return null;
  }

  const field = (name) => (client.fields || []).find((entry) => entry.name === name)?.value ?? null;

  return {
    id: client.id,
    name: client.name,
    enabled: client.enable === true,
    host: field("host"),
    port: field("port")
  };
}

/**
 * Why an app's configuration could not be read. `pending` means "ask again in a
 * moment"; `unknown` means something is actually wrong.
 */
function unreadable(app, fallbackReason) {
  return {
    state: app?.starting ? "pending" : "unknown",
    reason: app?.error || fallbackReason
  };
}

function describeApplication(application) {
  if (!application) {
    return null;
  }

  const field = (name) => (application.fields || []).find((entry) => entry.name === name)?.value ?? null;

  return {
    id: application.id,
    name: application.name,
    implementation: application.implementation,
    baseUrl: field("baseUrl")
  };
}

export class WiringService {
  constructor({
    arrApiImpl = arrApi,
    hostProfileService = null,
    inspectContainersImpl = inspectContainers,
    inspectNetworkDriversImpl = inspectNetworkDrivers,
    loadSettingsImpl = loadSettings,
    logger = defaultLogger,
    nowImpl = () => Date.now(),
    readApiKeyImpl = readApiKey
  } = {}) {
    this.now = nowImpl;
    this.arrApi = arrApiImpl;
    this.hostProfileService = hostProfileService;
    this.inspectContainers = inspectContainersImpl;
    this.inspectNetworkDrivers = inspectNetworkDriversImpl;
    this.loadSettingsImpl = loadSettingsImpl;
    this.logger = logger.child({ component: "wiring-service" });
    this.readApiKey = readApiKeyImpl;
  }

  async loadSettings() {
    if (this.hostProfileService) {
      return this.hostProfileService.loadSettings();
    }

    return this.loadSettingsImpl();
  }

  scopedLogger(context) {
    return context?.requestId ? this.logger.child({ requestId: context.requestId }) : this.logger;
  }

  /**
   * Reads the whole stack and reports what is wired, what is missing, and what
   * cannot be wired at all. Writes nothing — including the `testall` calls,
   * which run each app's own connection tests against its existing config.
   */
  async describeWiring(context = {}) {
    const logger = this.scopedLogger(context);
    const settings = await this.loadSettings();
    const hostAddress = hostAddressFrom(settings);
    const services = settings.selectedServiceIds
      .map((id) => settings.services[id])
      .filter(Boolean);

    // The controller is a source like any other: it has to reach each app's API
    // before it can report anything about it.
    const inspects = await this.inspectContainers(
      settings,
      [...services.map((service) => service.containerName), "stackarr"],
      { logger }
    );
    const byName = new Map(inspects.map((inspect) => [String(inspect.Name || "").replace(/^\//, ""), inspect]));
    const drivers = await this.inspectNetworkDrivers(
      settings,
      inspects.flatMap((inspect) => Object.keys(inspect?.NetworkSettings?.Networks || {})),
      { logger }
    );

    const endpoints = new Map();
    const mounts = new Map();

    for (const service of services) {
      const inspect = byName.get(service.containerName);
      endpoints.set(
        service.id,
        buildEndpoint({
          serviceId: service.id,
          name: service.name,
          containerName: service.containerName,
          fallbackPort: getServiceDefinition(service.id)?.defaultPort || service.port,
          inspect,
          networkDrivers: drivers
        })
      );
      mounts.set(service.id, readMounts(inspect));
    }

    const controller = buildEndpoint({
      serviceId: "stackarr",
      name: "Stackarr",
      containerName: "stackarr",
      fallbackPort: null,
      inspect: byName.get("stackarr"),
      networkDrivers: drivers
    });

    const keys = new Map();
    const participants = [];
    let downloadDirs = null;

    for (const service of services) {
      const endpoint = endpoints.get(service.id);
      const controllerLink = resolveLink(controller, endpoint, { hostAddress });
      let descriptor = { found: false, state: "unsupported", reason: `Stackarr does not read an API key for ${service.name}.` };
      let downloadSettings = null;

      if (hasReadableApiKey(service.id) && endpoint.running) {
        const read = await this.readApiKey(settings, service, { logger });
        descriptor = read.descriptor;
        downloadSettings = read.downloadSettings;

        if (downloadSettings) {
          downloadDirs = downloadSettings;
        }

        if (read.key) {
          keys.set(service.id, read.key);
        }
      }

      participants.push({
        serviceId: service.id,
        name: service.name,
        running: endpoint.running,
        topology: {
          kind: endpoint.kind,
          networkMode: endpoint.networkMode,
          containerPort: endpoint.containerPort
        },
        apiKey: descriptor,
        controllerLink: {
          ok: controllerLink.ok,
          baseUrl: controllerLink.baseUrl,
          strategy: controllerLink.strategy,
          reason: controllerLink.reason
        },
        downloads: downloadSettings
          ? { completeDir: downloadSettings.completeDir, hostWhitelist: downloadSettings.hostWhitelist }
          : null
      });
    }

    const current = await this.readCurrentConfig(services, endpoints, controller, keys, hostAddress, logger);
    const links = [
      ...this.checkDownloadClients(services, endpoints, current, hostAddress, mounts),
      ...this.checkProwlarrApplications(services, endpoints, current, hostAddress)
    ];
    const rootFolders = this.checkRootFolders(services, current, mounts, settings);
    const pathMappings = this.checkPathMappings(services, endpoints, mounts, hostAddress, downloadDirs?.completeDir);

    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      participants,
      links,
      rootFolders,
      pathMappings,
      ...this.summarize(links, rootFolders, participants)
    };
  }

  /** One authenticated read per app, reused by every check below. */
  async readCurrentConfig(services, endpoints, controller, keys, hostAddress, logger) {
    const current = new Map();

    for (const service of services) {
      const endpoint = endpoints.get(service.id);
      const key = keys.get(service.id);
      const link = resolveLink(controller, endpoint, { hostAddress });
      const entry = { reachable: false, error: null, downloadClients: [], rootFolders: [], applications: [], tests: null };

      if (!speaksArrApi(service.id) || !key || !link.ok) {
        entry.error = link.ok ? null : link.reason;
        current.set(service.id, entry);
        continue;
      }

      const status = await this.arrApi.systemStatus(service.id, link.baseUrl, key);

      if (!status.ok) {
        // An app that started moments ago has written its config but is not
        // serving requests yet. That is a stage of a normal install, not a
        // fault, and calling it one makes every fresh install look broken.
        entry.starting = isStillStarting(endpoint, this.now());
        entry.error = entry.starting
          ? `${service.name} has only just started and is not answering yet.`
          : status.error;
        current.set(service.id, entry);
        continue;
      }

      entry.reachable = true;
      entry.version = status.data?.version || null;

      if (service.id === "prowlarr") {
        const applications = await this.arrApi.listApplications(link.baseUrl, key);
        entry.applications = applications.data || [];
        entry.tests = await this.runTests(() => this.arrApi.testAllApplications(link.baseUrl, key));
      } else {
        const [clients, folders] = await Promise.all([
          this.arrApi.listDownloadClients(service.id, link.baseUrl, key),
          this.arrApi.listRootFolders(service.id, link.baseUrl, key)
        ]);
        entry.downloadClients = clients.data || [];
        entry.rootFolders = folders.data || [];
        entry.tests = await this.runTests(() =>
          this.arrApi.testAllDownloadClients(service.id, link.baseUrl, key)
        );
      }

      logger.debug("wiring.read", { serviceId: service.id, reachable: entry.reachable });
      current.set(service.id, entry);
    }

    return current;
  }

  /**
   * `testall` answers the question that matters: whether the app itself, from
   * its own network position, can reach what it is configured to use. Our own
   * probe would only prove the controller can, which is a different question
   * and gives a false pass whenever the two sit on different networks.
   */
  async runTests(run) {
    const result = await run();

    if (!result.ok) {
      return { ran: false, ok: false, message: result.error };
    }

    const entries = Array.isArray(result.data) ? result.data : [];
    const failures = entries.filter((entry) => entry.isValid === false);

    return {
      ran: true,
      ok: failures.length === 0,
      message: failures.length
        ? failures
            .map((entry) => (entry.validationFailures || []).map((failure) => failure.errorMessage).join("; "))
            .filter(Boolean)
            .join(" | ") || "The app reported a failing connection."
        : `${entries.length} connection test${entries.length === 1 ? "" : "s"} passed.`
    };
  }

  checkDownloadClients(services, endpoints, current, hostAddress, mounts) {
    const downloader = services.find((service) => service.id === "sabnzbd");

    return services
      .filter((service) => ACQUIRERS.includes(service.id))
      .map((service) => {
        const base = {
          id: `${service.id}->sabnzbd:downloadclient`,
          kind: "download-client",
          source: service.id,
          sourceName: service.name,
          target: "sabnzbd",
          targetName: "SABnzbd"
        };

        if (!downloader) {
          return { ...base, state: "not-applicable", reason: "SABnzbd is not part of this stack." };
        }

        const app = current.get(service.id);

        if (!app?.reachable) {
          return { ...base, ...unreadable(app, `Stackarr could not read ${service.name}'s configuration.`) };
        }

        const link = resolveLink(endpoints.get(service.id), endpoints.get("sabnzbd"), { hostAddress });

        if (!link.ok) {
          return { ...base, state: "blocked", reason: link.reason, address: null };
        }

        const result = reconcileDownloadClient(app.downloadClients, { host: link.host, port: link.port });

        return {
          ...base,
          state: result.state,
          address: { baseUrl: link.baseUrl, host: link.host, port: link.port, strategy: link.strategy },
          addressReason: link.reason,
          actual: describeDownloadClient(result.target),
          changes: result.changes,
          reason: result.reason,
          test: result.state === RECONCILE_STATE.CORRECT ? app.tests : null
        };
      });
  }

  checkProwlarrApplications(services, endpoints, current, hostAddress) {
    const prowlarr = services.find((service) => service.id === "prowlarr");
    const acquirers = services.filter((service) => ACQUIRERS.includes(service.id));

    if (!prowlarr) {
      return acquirers.map((service) => ({
        id: `prowlarr->${service.id}:application`,
        kind: "indexer-app",
        source: "prowlarr",
        sourceName: "Prowlarr",
        target: service.id,
        targetName: service.name,
        state: "not-applicable",
        reason: "Prowlarr is not part of this stack, so nothing syncs indexers into this app."
      }));
    }

    const app = current.get("prowlarr");

    return acquirers.map((service) => {
      const base = {
        id: `prowlarr->${service.id}:application`,
        kind: "indexer-app",
        source: "prowlarr",
        sourceName: "Prowlarr",
        target: service.id,
        targetName: service.name
      };

      if (!app?.reachable) {
        return { ...base, ...unreadable(app, "Stackarr could not read Prowlarr's configuration.") };
      }

      // A Prowlarr application needs both directions: baseUrl is how Prowlarr
      // reaches the app, prowlarrUrl is how the app reaches Prowlarr back. On a
      // stack with mixed network modes those are genuinely different strings.
      const inbound = resolveLink(endpoints.get("prowlarr"), endpoints.get(service.id), { hostAddress });
      const outbound = resolveLink(endpoints.get(service.id), endpoints.get("prowlarr"), { hostAddress });

      if (!inbound.ok || !outbound.ok) {
        return { ...base, state: "blocked", reason: inbound.ok ? outbound.reason : inbound.reason, address: null };
      }

      const result = reconcileApplication(app.applications, {
        implementation: PROWLARR_IMPLEMENTATION[service.id],
        baseUrl: inbound.baseUrl
      });

      return {
        ...base,
        state: result.state,
        address: { baseUrl: inbound.baseUrl, prowlarrUrl: outbound.baseUrl, strategy: inbound.strategy },
        addressReason: inbound.reason,
        actual: describeApplication(result.target),
        changes: result.changes,
        reason: result.reason,
        test: result.state === RECONCILE_STATE.CORRECT ? app.tests : null
      };
    });
  }

  checkRootFolders(services, current, mounts, settings) {
    return services
      .filter((service) => ACQUIRERS.includes(service.id))
      .map((service) => {
        const app = current.get(service.id);
        const base = { serviceId: service.id, name: service.name };

        if (!app?.reachable) {
          return { ...base, ...unreadable(app, `Stackarr could not read ${service.name}'s configuration.`) };
        }

        const plan = planRootFolder(mounts.get(service.id) || [], service.id, settings.mediaRoot);

        if (!plan.ok) {
          return { ...base, state: "blocked", reason: plan.reason };
        }

        const result = reconcileRootFolder(app.rootFolders, plan);

        return {
          ...base,
          state: result.state,
          expectedPath: plan.expectedPath,
          derivedFrom: plan.derivedFrom,
          actual: app.rootFolders.map((folder) => ({ path: folder.path, accessible: folder.accessible !== false })),
          reason: result.reason
        };
      });
  }

  checkPathMappings(services, endpoints, mounts, hostAddress, completeDir) {
    if (!services.some((service) => service.id === "sabnzbd")) {
      return [];
    }

    return services
      .filter((service) => ACQUIRERS.includes(service.id))
      .map((service) => {
        const link = resolveLink(endpoints.get(service.id), endpoints.get("sabnzbd"), { hostAddress });
        const plan = planPathMapping({
          downloadMounts: mounts.get("sabnzbd") || [],
          completeDir,
          arrMounts: mounts.get(service.id) || [],
          downloadHost: link.host
        });

        return {
          serviceId: service.id,
          name: service.name,
          state: plan.blocked ? "blocked" : plan.needed ? "absent" : "not-needed",
          mapping: plan.mapping || null,
          reason: plan.reason
        };
      });
  }

  summarize(links, rootFolders, participants) {
    const states = [...links, ...rootFolders]
      .map((entry) => entry.state)
      .filter((state) => state !== "not-applicable");
    const count = (state) => states.filter((entry) => entry === state).length;
    const summary = {
      total: states.length,
      correct: count(RECONCILE_STATE.CORRECT),
      drift: count(RECONCILE_STATE.DRIFT),
      ambiguous: count(RECONCILE_STATE.AMBIGUOUS),
      absent: count(RECONCILE_STATE.ABSENT),
      blocked: count("blocked"),
      pending: count("pending"),
      unknown: count("unknown")
    };

    // An app can be young in two ways: it has not written its API key yet, or it
    // has but is not serving requests. Both are stages of a normal install, and
    // neither should be reported as a fault.
    const starting = participants
      .filter((participant) => participant.apiKey?.state === "pending")
      .map((participant) => participant.name);

    if (starting.length > 0 || summary.pending > 0) {
      const names = starting.length ? `${starting.join(", ")} has` : "Part of the stack has";

      return {
        summary,
        readiness: READINESS.PENDING,
        readinessMessage: `${names} only just started and is not ready to answer yet. Check again in a few seconds.`
      };
    }

    if (summary.blocked > 0) {
      return {
        summary,
        readiness: READINESS.BLOCKED,
        readinessMessage: `${summary.blocked} link${summary.blocked === 1 ? "" : "s"} cannot be made on this host's networking, so ${
          summary.blocked === 1 ? "it needs" : "they need"
        } a change to how the containers are attached.`
      };
    }

    if (summary.correct === summary.total && summary.total > 0) {
      return {
        summary,
        readiness: READINESS.READY,
        readinessMessage: `Stack ready. All ${summary.total} connections are configured correctly.`
      };
    }

    const outstanding = [
      summary.absent && `${summary.absent} missing`,
      summary.drift && `${summary.drift} pointing elsewhere`,
      summary.ambiguous && `${summary.ambiguous} ambiguous`,
      // Named explicitly, or the count simply would not add up on screen.
      summary.unknown && `${summary.unknown} that Stackarr could not read`
    ].filter(Boolean);

    return {
      summary,
      readiness: READINESS.INCOMPLETE,
      readinessMessage: `${summary.correct} of ${summary.total} connections are configured: ${outstanding.join(", ")}.`
    };
  }
}
