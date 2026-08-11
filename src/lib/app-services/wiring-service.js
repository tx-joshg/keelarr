import { createLogger } from "../logger.js";
import { StackarrError } from "../errors.js";
import { JobRegistry } from "../jobs.js";
import { appendActivity, loadSettings } from "../store.js";
import { buildApplicationPayload, buildDownloadClientPayload, describeValidation } from "../wiring/payloads.js";
import { attachController, planControllerAttachments } from "../wiring/attach.js";
import { ensureSharedNetwork, inspectContainers } from "../runtime.js";
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
import { SHARED_NETWORK, getServiceDefinition } from "../service-catalog.js";

const defaultLogger = createLogger();

/** Apps that acquire releases and therefore need a download client. */
const ACQUIRERS = ["radarr", "sonarr", "lidarr"];

/** How each acquirer identifies itself to Prowlarr. */
const PROWLARR_IMPLEMENTATION = { radarr: "Radarr", sonarr: "Sonarr", lidarr: "Lidarr" };

export const WIRING_STEPS = [
  { name: "plan", label: "Work out what needs to change" },
  { name: "downloadclients", label: "Add the download client to each app" },
  { name: "rootfolders", label: "Add library folders" },
  { name: "applications", label: "Register the apps with Prowlarr" },
  { name: "verify", label: "Run each app's own connection tests" }
];

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
 * Arr apps mask fields marked `privacy: "apiKey"` in their schema, returning
 * `********` instead of the value, so a spread would not leak today. Naming
 * every field we publish is still the rule: the masking is the remote app's
 * behaviour to change, not ours, and it does not hold for every field on every
 * endpoint. Whatever crosses into the response is a decision, not a default.
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

/**
 * What Stackarr actually relies on to know this app is alive.
 *
 * Worth stating outright: an app the controller cannot reach is not
 * unmonitored if Docker is health-checking it, and one with neither is a real
 * gap the operator should know about rather than infer from a silent row.
 */
function describeMonitoring(endpoint, controllerLink) {
  if (controllerLink.ok) {
    return {
      level: "probe",
      summary: `Checked over HTTP at ${controllerLink.baseUrl}.`
    };
  }

  if (endpoint.hasHealthcheck) {
    return {
      level: "healthcheck",
      summary: `Stackarr cannot reach this app directly, but the container reports its own health, which is a real signal.`
    };
  }

  return {
    level: "process",
    summary: `Stackarr cannot reach this app and the container has no healthcheck, so only the process is known to be up — nothing confirms it is serving.`
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
    appendActivityImpl = appendActivity,
    arrApiImpl = arrApi,
    attachControllerImpl = attachController,
    ensureSharedNetworkImpl = ensureSharedNetwork,
    hostProfileService = null,
    inspectContainersImpl = inspectContainers,
    inspectNetworkDriversImpl = inspectNetworkDrivers,
    jobs = null,
    loadSettingsImpl = loadSettings,
    logger = defaultLogger,
    nowImpl = () => Date.now(),
    readApiKeyImpl = readApiKey
  } = {}) {
    this.now = nowImpl;
    this.appendActivity = appendActivityImpl;
    this.attachController = attachControllerImpl;
    this.ensureSharedNetwork = ensureSharedNetworkImpl;
    this.jobs = jobs;
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
    return (await this.gather(context)).report;
  }

  /**
   * Reads everything once and returns both the public report and the internals
   * the apply job needs. Applying re-gathers rather than trusting a report the
   * caller sends back, so a stale browser tab cannot direct a write.
   */
  async gather(context = {}) {
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
        monitoring: describeMonitoring(endpoint, controllerLink),
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
      settings,
      hostAddress,
      services,
      controller,
      endpoints,
      mounts,
      keys,
      current,
      logger,
      report: {
        ok: true,
        checkedAt: new Date(this.now()).toISOString(),
        participants,
        links,
        rootFolders,
        pathMappings,
        ...this.summarize(links, rootFolders, participants)
      }
    };
  }

  /**
   * Joins the controller to the networks its services live on.
   *
   * Run at startup rather than during a check, because the check is read-only
   * and must stay that way. Running it every start is what makes it survive the
   * controller being recreated — the attachment lives on the container, not in
   * a Compose file, so it is re-derived rather than remembered.
   */
  async attachToServiceNetworks(context = {}) {
    const logger = this.scopedLogger(context);

    try {
      const settings = await this.loadSettings();
      // Created here rather than by Compose: QNAP's Container Station cannot
      // create a Compose-owned bridge network, but accepts this call fine.
      await this.ensureSharedNetwork(settings, SHARED_NETWORK, { logger });

      const { controller, endpoints } = await this.gather(context);
      const plan = planControllerAttachments(controller, [...endpoints.values()], SHARED_NETWORK);

      if (plan.length === 0) {
        return { attached: [], skipped: [] };
      }

      const result = await this.attachController(settings, plan, { logger });

      for (const entry of result.attached) {
        logger.info("wiring.controller_attached", { network: entry.network, services: entry.services });
      }

      for (const entry of result.skipped) {
        logger.warn("wiring.controller_attach_skipped", { network: entry.network, reason: entry.reason });
      }

      return result;
    } catch (error) {
      // Monitoring reach is a convenience. Failing to widen it must never stop
      // the controller from starting.
      logger.warn("wiring.controller_attach_failed", { message: error.message });
      return { attached: [], skipped: [] };
    }
  }

  requireJobs() {
    if (!this.jobs) {
      this.jobs = new JobRegistry({ logger: this.logger, persist: true });
    }

    return this.jobs;
  }

  /**
   * Stack-level, so the subject carries no service id. `subjectKey` in the job
   * registry then yields `wiring:`, which makes wiring exclusive with itself
   * and non-conflicting with per-service jobs. That is what we want here.
   */
  startWiring(input = {}, context = {}) {
    const job = this.requireJobs().create({ kind: "wiring", subject: { scope: "stack" }, steps: WIRING_STEPS });
    return this.jobs.start(job, (ctx) => this.runWiring(ctx, input, context));
  }

  async runWiring(ctx, input, context) {
    let plan = null;

    await ctx.step("plan", async () => {
      const gathered = await this.gather(context);
      // Only what is genuinely missing. Drift, ambiguity, and blocked links are
      // reported by the check and deliberately never written by this job.
      const actionable = {
        downloadClients: gathered.report.links.filter(
          (link) => link.kind === "download-client" && link.state === RECONCILE_STATE.ABSENT
        ),
        applications: gathered.report.links.filter(
          (link) => link.kind === "indexer-app" && link.state === RECONCILE_STATE.ABSENT
        ),
        rootFolders: gathered.report.rootFolders.filter((folder) => folder.state === RECONCILE_STATE.ABSENT)
      };
      const total =
        actionable.downloadClients.length + actionable.applications.length + actionable.rootFolders.length;

      if (total === 0) {
        throw new StackarrError("Nothing to wire — every connection is already configured.", { statusCode: 409 });
      }

      plan = { ...gathered, actionable };
      return { detail: `${total} connection${total === 1 ? "" : "s"} to configure.` };
    });

    const { keys, current, logger } = plan;
    const created = [];
    const skipped = [];

    await this.applyDownloadClients(ctx, plan, created, logger);
    await this.applyRootFolders(ctx, plan, created, logger);
    await this.applyApplications(ctx, plan, created, skipped, logger);

    const verification = await ctx.step("verify", async () => {
      const results = [];

      for (const serviceId of new Set(created.map((entry) => entry.serviceId))) {
        const link = current.get(serviceId)?.baseUrl;
        const key = keys.get(serviceId);

        if (!link || !key) {
          continue;
        }

        const outcome =
          serviceId === "prowlarr"
            ? await this.runTests(() => this.arrApi.testAllApplications(link, key))
            : await this.runTests(() => this.arrApi.testAllDownloadClients(serviceId, link, key));
        results.push({ serviceId, ...outcome });
      }

      const failed = results.filter((entry) => !entry.ok);
      return {
        detail: failed.length
          ? `${failed.length} app reported a failing connection.`
          : `Every app confirmed its connections.`,
        results
      };
    });

    await this.appendActivity({
      kind: "wiring-apply",
      level: verification.results.some((entry) => !entry.ok) ? "warn" : "info",
      message: `Configured ${created.length} connection${created.length === 1 ? "" : "s"} across the stack.`,
      details: { created: created.map((entry) => entry.label) }
    });

    logger.info("wiring.applied", { created: created.length, skipped: skipped.length });

    return {
      created: created.map((entry) => entry.label),
      skipped,
      verification: verification.results,
      summary: `Configured ${created.length} connection${created.length === 1 ? "" : "s"}.`
    };
  }

  /**
   * Builds the payload from the app's own schema, tests it, then writes it.
   *
   * The API key is supplied from the file we read it out of rather than copied
   * from anything the app returned: Arr apps mask secret fields on read, and a
   * client created from a masked value stores the mask and gets 403 forever.
   */
  async applyDownloadClients(ctx, plan, created, logger) {
    const { actionable, current, keys } = plan;

    if (actionable.downloadClients.length === 0) {
      ctx.skip("downloadclients", "Every app already has its download client configured.");
      return;
    }

    await ctx.step("downloadclients", async () => {
      const downloadKey = keys.get("sabnzbd");

      if (!downloadKey) {
        throw new StackarrError("SABnzbd's API key could not be read, so no download client can be configured.", {
          statusCode: 422
        });
      }

      for (const link of actionable.downloadClients) {
        const base = current.get(link.source)?.baseUrl;
        const key = keys.get(link.source);
        const schema = await this.arrApi.downloadClientSchema(link.source, base, key);

        if (!schema.ok) {
          throw new StackarrError(`${link.sourceName} would not describe its download client options: ${schema.error}`, {
            statusCode: 502
          });
        }

        const payload = buildDownloadClientPayload(schema.data, {
          name: "SABnzbd",
          host: link.address.host,
          port: link.address.port,
          apiKey: downloadKey
        });

        await this.writeChecked({
          label: `${link.sourceName} → SABnzbd`,
          test: () => this.arrApi.testDownloadClient(link.source, base, key, payload),
          create: () => this.arrApi.createDownloadClient(link.source, base, key, payload),
          serviceId: link.source,
          created,
          logger
        });
      }

      return { detail: `Configured ${actionable.downloadClients.length}.` };
    });
  }

  async applyRootFolders(ctx, plan, created, logger) {
    const { actionable, current, keys } = plan;

    if (actionable.rootFolders.length === 0) {
      ctx.skip("rootfolders", "Every app already has a library folder inside the media mount.");
      return;
    }

    await ctx.step("rootfolders", async () => {
      for (const folder of actionable.rootFolders) {
        const result = await this.arrApi.createRootFolder(
          folder.serviceId,
          current.get(folder.serviceId)?.baseUrl,
          keys.get(folder.serviceId),
          folder.expectedPath
        );

        if (!result.ok) {
          throw new StackarrError(`${folder.name} rejected the library folder ${folder.expectedPath}: ${result.error}`, {
            statusCode: 502
          });
        }

        created.push({ serviceId: folder.serviceId, label: `${folder.name} library folder ${folder.expectedPath}` });
        logger.info("wiring.rootfolder.created", { serviceId: folder.serviceId, path: folder.expectedPath });
      }

      return { detail: `Added ${actionable.rootFolders.length}.` };
    });
  }

  async applyApplications(ctx, plan, created, skipped, logger) {
    const { actionable, current, keys } = plan;

    if (actionable.applications.length === 0) {
      ctx.skip("applications", "Prowlarr already knows about every app, or is not part of this stack.");
      return;
    }

    await ctx.step("applications", async () => {
      const base = current.get("prowlarr")?.baseUrl;
      const key = keys.get("prowlarr");
      const schema = await this.arrApi.applicationSchema(base, key);

      if (!schema.ok) {
        throw new StackarrError(`Prowlarr would not describe its application options: ${schema.error}`, {
          statusCode: 502
        });
      }

      for (const link of actionable.applications) {
        const targetKey = keys.get(link.target);

        if (!targetKey) {
          skipped.push(`${link.targetName} — its API key could not be read.`);
          continue;
        }

        const payload = buildApplicationPayload(schema.data, {
          implementation: PROWLARR_IMPLEMENTATION[link.target],
          name: link.targetName,
          prowlarrUrl: link.address.prowlarrUrl,
          baseUrl: link.address.baseUrl,
          apiKey: targetKey
        });

        await this.writeChecked({
          label: `Prowlarr → ${link.targetName}`,
          test: () => this.arrApi.testApplication(base, key, payload),
          create: () => this.arrApi.createApplication(base, key, payload),
          serviceId: "prowlarr",
          created,
          logger
        });
      }

      return { detail: `Registered ${created.filter((entry) => entry.serviceId === "prowlarr").length}.` };
    });
  }

  /**
   * Test, then write.
   *
   * Arr apps validate on save too, so this is not the only guard — but testing
   * first means a refusal is reported against the thing we were about to do,
   * with the app's own description of why, instead of surfacing as a bare 400
   * from a write that already half-happened. `forceSave` is never used: an app
   * refusing a config it cannot reach is correct, and overriding that is how
   * you end up with settings that look right and never work.
   */
  async writeChecked({ label, test, create, serviceId, created, logger }) {
    const tested = await test();

    if (!tested.ok) {
      throw new StackarrError(`${label} was not configured: ${tested.error}`, { statusCode: 422 });
    }

    const rejection = describeValidation(tested.data);

    if (rejection) {
      throw new StackarrError(`${label} was not configured: ${rejection}`, { statusCode: 422 });
    }

    const result = await create();

    if (!result.ok) {
      throw new StackarrError(`${label} could not be saved: ${result.error}`, { statusCode: 502 });
    }

    created.push({ serviceId, label });
    logger.info("wiring.created", { label });
  }

  /** One authenticated read per app, reused by every check below. */
  async readCurrentConfig(services, endpoints, controller, keys, hostAddress, logger) {
    const current = new Map();

    for (const service of services) {
      const endpoint = endpoints.get(service.id);
      const key = keys.get(service.id);
      const link = resolveLink(controller, endpoint, { hostAddress });
      const entry = {
        reachable: false,
        error: null,
        baseUrl: link.ok ? link.baseUrl : null,
        downloadClients: [],
        rootFolders: [],
        applications: [],
        tests: null
      };

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
