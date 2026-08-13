import { access } from "node:fs/promises";

import { createLogger } from "../logger.js";
import { KeelarrError } from "../errors.js";
import { JobRegistry } from "../jobs.js";
import { appendActivity, loadSettings } from "../store.js";
import {
  buildApplicationPayload,
  buildDownloadClientPayload,
  buildIndexerProxyPayload,
  buildRootFolderPayload,
  describeValidation,
  missingCategoryFor
} from "../wiring/payloads.js";
import { attachController, planControllerAttachments } from "../wiring/attach.js";
import { ensureSharedNetwork, inspectContainers } from "../runtime.js";
import { arrApi, bazarrApi, probeJellyfin, probeQbittorrent, sabnzbdApi, speaksArrApi } from "../wiring/app-clients.js";
import { hasReadableApiKey, readApiKey } from "../wiring/api-keys.js";
import { readContainerFile } from "../runtime.js";
import { LAN_CLIENT, buildEndpoint, inspectNetworkDrivers, isStillStarting, resolveLink } from "../wiring/topology.js";
import { planPathMapping, planRootFolder, readMounts } from "../wiring/path-plan.js";
import { ensureLibraryFolder } from "../wiring/provision.js";
import { findMissingPrerequisites, settingsLinkFor } from "../wiring/prerequisites.js";
import {
  RECONCILE_STATE,
  reconcileApplication,
  reconcileDownloadClient,
  reconcileIndexerProxy,
  reconcileRootFolder,
  reconcileSettingsLink
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
  { name: "proxies", label: "Give Prowlarr its challenge solver" },
  { name: "subtitles", label: "Point Bazarr at the library apps" },
  { name: "verify", label: "Run each app's own connection tests" }
];

const READINESS = Object.freeze({
  READY: "ready",
  INCOMPLETE: "incomplete",
  BLOCKED: "blocked",
  PENDING: "pending",
  /**
   * Every connection Keelarr manages is correct, but the stack still cannot do
   * its job because something only the operator can supply is missing.
   *
   * Worth its own state. Reporting "ready" here would be true about the wiring
   * and false about the thing the operator actually cares about: a stack with
   * no indexer is perfectly wired and cannot find a single release.
   */
  NEEDS_YOU: "needs-you"
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
 * What Keelarr actually relies on to know this app is alive.
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
      summary: `Keelarr cannot reach this app directly, but the container reports its own health, which is a real signal.`
    };
  }

  return {
    level: "process",
    summary: `Keelarr cannot reach this app and the container has no healthcheck, so only the process is known to be up — nothing confirms it is serving.`
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
    ensureLibraryFolderImpl = ensureLibraryFolder,
    attachControllerImpl = attachController,
    ensureSharedNetworkImpl = ensureSharedNetwork,
    hostProfileService = null,
    inspectContainersImpl = inspectContainers,
    inspectNetworkDriversImpl = inspectNetworkDrivers,
    jobs = null,
    loadSettingsImpl = loadSettings,
    logger = defaultLogger,
    nowImpl = () => Date.now(),
    pathExistsImpl = async (target) => {
      try {
        await access(target);
        return true;
      } catch {
        return false;
      }
    },
    readApiKeyImpl = readApiKey,
    readContainerFileImpl = readContainerFile,
    bazarrApiImpl = bazarrApi,
    probeJellyfinImpl = probeJellyfin,
    probeQbittorrentImpl = probeQbittorrent,
    sabnzbdApiImpl = sabnzbdApi,
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  } = {}) {
    this.now = nowImpl;
    this.appendActivity = appendActivityImpl;
    this.attachController = attachControllerImpl;
    this.ensureSharedNetwork = ensureSharedNetworkImpl;
    this.jobs = jobs;
    this.arrApi = arrApiImpl;
    this.ensureLibraryFolder = ensureLibraryFolderImpl;
    this.hostProfileService = hostProfileService;
    this.inspectContainers = inspectContainersImpl;
    this.inspectNetworkDrivers = inspectNetworkDriversImpl;
    this.loadSettingsImpl = loadSettingsImpl;
    this.logger = logger.child({ component: "wiring-service" });
    this.pathExists = pathExistsImpl;
    this.readApiKey = readApiKeyImpl;
    this.readContainerFile = readContainerFileImpl;
    this.bazarrApi = bazarrApiImpl;
    this.probeJellyfin = probeJellyfinImpl;
    this.probeQbittorrent = probeQbittorrentImpl;
    this.sabnzbdApi = sabnzbdApiImpl;
    this.sleep = sleepImpl;
  }

  async loadSettings() {
    if (this.hostProfileService) {
      return this.hostProfileService.loadSettings();
    }

    return this.loadSettingsImpl();
  }

  /**
   * Why a link could not be resolved: not yet, or not at all.
   *
   * A container created seconds ago has no usable address, and calling that
   * "blocked" is both wrong and consequential — blocked is a fault to report,
   * while pending is a reason to wait. Post-deploy wiring ran ten seconds after
   * creating FlareSolverr, found it blocked rather than pending, waited for
   * nothing, and concluded every connection was already configured.
   *
   * Only apps with an API key were ever given this benefit, because pending was
   * derived from whether that key had appeared. A service that has no API key
   * at all could never be pending, however new it was.
   */
  linkNotReady(endpoint, reason, name) {
    if (isStillStarting(endpoint, this.now())) {
      return { state: "pending", reason: `${name} has only just started and is not answering yet.` };
    }

    return { state: "blocked", reason };
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
      [...services.map((service) => service.containerName), "keelarr"],
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
      serviceId: "keelarr",
      name: "Keelarr",
      containerName: "keelarr",
      fallbackPort: null,
      inspect: byName.get("keelarr"),
      networkDrivers: drivers
    });

    const keys = new Map();
    const participants = [];
    let downloadDirs = null;

    for (const service of services) {
      const endpoint = endpoints.get(service.id);
      const controllerLink = resolveLink(controller, endpoint, { hostAddress });
      let descriptor = { found: false, state: "unsupported", reason: `Keelarr does not read an API key for ${service.name}.` };
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
    await this.readPrerequisiteState(services, current, keys, settings, logger);

    // Links the operator clicks, so resolved from a browser's position rather
    // than the controller's — a container name would not resolve for them.
    const appUrls = Object.fromEntries(
      services.map((service) => {
        const link = resolveLink(LAN_CLIENT, endpoints.get(service.id), { hostAddress });
        return [service.id, link.ok ? link.baseUrl : service.appUrl];
      })
    );
    const prerequisites = findMissingPrerequisites({ apps: current, services, appUrls });
    const links = [
      ...this.checkDownloadClients(services, endpoints, current, hostAddress, mounts),
      ...this.checkProwlarrApplications(services, endpoints, current, hostAddress),
      ...this.checkIndexerProxy(services, endpoints, current, hostAddress),
      ...this.checkBazarrLinks(services, endpoints, current, hostAddress)
    ];
    const rootFolders = this.checkRootFolders(services, current, mounts, settings);
    const pathMappings = this.checkPathMappings(services, endpoints, mounts, hostAddress, downloadDirs?.completeDir);

    return {
      settings,
      hostAddress,
      services,
      controller,
      // SABnzbd's real category list, so a payload never names one it lacks.
      downloadCategories: downloadDirs?.categories || null,
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
        prerequisites,
        ...this.summarize(links, rootFolders, participants, prerequisites)
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

  /**
   * Re-reads the stack until nothing is still starting up.
   *
   * Bounded, and it gives up rather than failing: an app that never settles
   * still gets a plan built from what could be read, and its links are reported
   * as pending rather than silently treated as needing nothing.
   */
  /**
   * Budget chosen from what a cold start actually costs, not from what feels
   * patient: FlareSolverr on the NAS took 61 seconds just to launch its browser
   * and about 80 before it served anything. The old 25 seconds expired while
   * every newly deployed app was still booting.
   *
   * It costs nothing when nothing is pending, because the loop returns on the
   * first gather that finds none.
   */
  async gatherOnceSettled(context, ctx, { attempts = 24, intervalMs = 5000 } = {}) {
    let gathered = await this.gather(context);

    for (let attempt = 1; attempt < attempts; attempt += 1) {
      if (gathered.report.readiness !== READINESS.PENDING) {
        return gathered;
      }

      const stillStarting = [
        ...gathered.report.participants
          .filter((participant) => participant.apiKey?.state === "pending")
          .map((participant) => participant.name),
        // Services with no API key are pending through their links instead, and
        // naming them is the difference between a progress line that explains
        // the wait and one that says "an app".
        ...gathered.report.links
          .filter((link) => link.state === "pending")
          .map((link) => link.targetName || link.targetId)
      ];

      ctx?.note("plan", `Waiting for ${[...new Set(stillStarting)].join(", ") || "an app"} to finish starting.`);

      await this.sleep(intervalMs);
      gathered = await this.gather(context);
    }

    return gathered;
  }

  async runWiring(ctx, input, context) {
    let plan = null;

    await ctx.step("plan", async () => {
      // An app deployed moments ago has not written its API key yet, and one
      // whose configuration cannot be read looks like it needs nothing. Waiting
      // for that is the difference between an install that finishes connected
      // and one that quietly does nothing.
      const gathered = await this.gatherOnceSettled(context, ctx);
      // Only what is genuinely missing. Drift, ambiguity, and blocked links are
      // reported by the check and deliberately never written by this job.
      const actionable = {
        downloadClients: gathered.report.links.filter(
          (link) => link.kind === "download-client" && link.state === RECONCILE_STATE.ABSENT
        ),
        applications: gathered.report.links.filter(
          (link) => link.kind === "indexer-app" && link.state === RECONCILE_STATE.ABSENT
        ),
        rootFolders: gathered.report.rootFolders.filter((folder) => folder.state === RECONCILE_STATE.ABSENT),
        proxies: gathered.report.links.filter(
          (link) => link.kind === "indexer-proxy" && link.state === RECONCILE_STATE.ABSENT
        ),
        subtitles: gathered.report.links.filter(
          (link) => link.kind === "subtitle-source" && link.state === RECONCILE_STATE.ABSENT
        )
      };
      const total =
        actionable.downloadClients.length +
        actionable.applications.length +
        actionable.rootFolders.length +
        actionable.proxies.length +
        actionable.subtitles.length;

      if (total === 0) {
        throw new KeelarrError("Nothing to wire — every connection is already configured.", { statusCode: 409 });
      }

      plan = { ...gathered, actionable, downloadCategories: gathered.downloadCategories };
      return { detail: `${total} connection${total === 1 ? "" : "s"} to configure.` };
    });

    const { keys, current, logger } = plan;
    const created = [];
    const skipped = [];
    // Populated by writeChecked. One app refusing a connection says nothing
    // about the others, so a failure here is collected rather than thrown.
    const failed = [];
    const notes = [];
    this.outcome = { created, failed, notes };

    await this.applyDownloadClients(ctx, plan, created, logger);
    await this.applyRootFolders(ctx, plan, created, logger);
    await this.applyApplications(ctx, plan, created, skipped, logger);
    await this.applyIndexerProxies(ctx, plan, created, skipped, logger);
    await this.applySubtitleLinks(ctx, plan, created, logger);

    const verification = await ctx.step("verify", async () => {
      const results = [];

      for (const serviceId of new Set(created.map((entry) => entry.serviceId))) {
        const link = current.get(serviceId)?.baseUrl;
        const key = keys.get(serviceId);

        // Only apps with a testall endpoint. Bazarr has none, and asking for
        // one returns a 404 that reads as a failing connection.
        if (!link || !key || !speaksArrApi(serviceId)) {
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
      level: failed.length || verification.results.some((entry) => !entry.ok) ? "warn" : "info",
      message: created.length
        ? `Configured ${created.length} connection${created.length === 1 ? "" : "s"} across the stack.`
        : `Configured nothing: ${failed.length} connection${failed.length === 1 ? "" : "s"} were refused.`,
      details: { created: created.map((entry) => entry.label) }
    });

    logger.info("wiring.applied", { created: created.length, failed: failed.length, skipped: skipped.length });

    // Asked to configure something, configured none of it, and every attempt
    // was refused. Reporting that as a successful job is how an operator ends
    // up believing a connection exists that does not — the same way an upgrade
    // once reported success with a failed step.
    if (created.length === 0 && failed.length > 0) {
      throw new KeelarrError(
        `Nothing could be configured. ${failed.map((entry) => `${entry.label}: ${entry.reason}`).join("; ")}`,
        { statusCode: 502, details: { failed } }
      );
    }

    return {
      created: created.map((entry) => entry.label),
      failed,
      notes,
      skipped,
      verification: verification.results,
      summary: failed.length
        ? `Configured ${created.length} connection${created.length === 1 ? "" : "s"}; ${failed.length} could not be configured.`
        : `Configured ${created.length} connection${created.length === 1 ? "" : "s"}.`
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
    const { actionable, current, keys, downloadCategories } = plan;

    if (actionable.downloadClients.length === 0) {
      ctx.skip("downloadclients", "Every app already has its download client configured.");
      return;
    }

    await ctx.step("downloadclients", async () => {
      const failedBefore = this.outcome.failed.length;
      const downloadKey = keys.get("sabnzbd");

      if (!downloadKey) {
        throw new KeelarrError("SABnzbd's API key could not be read, so no download client can be configured.", {
          statusCode: 422
        });
      }

      for (const link of actionable.downloadClients) {
        const base = current.get(link.source)?.baseUrl;
        const key = keys.get(link.source);
        const schema = await this.arrApi.downloadClientSchema(link.source, base, key);

        if (!schema.ok) {
          throw new KeelarrError(`${link.sourceName} would not describe its download client options: ${schema.error}`, {
            statusCode: 502
          });
        }

        // Checked before attempting, because the app refuses the write outright
        // and its own error names a field rather than the actual problem.
        const missingCategory = missingCategoryFor(schema.data, link.source, downloadCategories);

        if (missingCategory) {
          // Adding it rather than asking the operator to. Keelarr already
          // writes download clients into these apps; refusing to add the
          // category that makes one work is an inconsistent place to stop.
          const added = await this.sabnzbdApi.createCategory(
            current.get("sabnzbd")?.baseUrl,
            downloadKey,
            missingCategory
          );

          if (!added.ok) {
            this.outcome.failed.push({
              label: `${link.sourceName} → SABnzbd`,
              reason: `${link.sourceName} needs a "${missingCategory}" download category and SABnzbd would not add one: ${added.error}`
            });
            continue;
          }

          this.outcome.notes.push(`Added the "${missingCategory}" category to SABnzbd so ${link.sourceName} can separate its downloads.`);
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

      return { detail: this.describeOutcome(actionable.downloadClients.length, failedBefore) };
    });
  }

  async applyRootFolders(ctx, plan, created, logger) {
    const { actionable, current, keys } = plan;

    if (actionable.rootFolders.length === 0) {
      ctx.skip("rootfolders", "Every app already has a library folder inside the media mount.");
      return;
    }

    await ctx.step("rootfolders", async () => {
      const failedBefore = this.outcome.failed.length;
      for (const folder of actionable.rootFolders) {
        // The app will not accept a folder that is not there, and the path is
        // inside the media root the operator configured, so Keelarr creates
        // it. Note the translation: the app sees /Media, the controller sees
        // /share/Media, and checking the container path here would test a
        // directory that can never exist on this filesystem.
        const ready = await this.ensureLibraryFolder(plan.mounts.get(folder.serviceId) || [], folder.expectedPath);

        if (!ready.ok) {
          this.outcome.failed.push({ label: `${folder.name} library folder`, reason: ready.reason });
          continue;
        }

        if (ready.created) {
          this.outcome.notes.push(`Created ${ready.hostPath} for ${folder.name}'s library.`);
        }

        const base = current.get(folder.serviceId)?.baseUrl;
        const key = keys.get(folder.serviceId);
        // Lidarr will not take a bare path; it wants a name and default
        // profiles, whose ids differ per install and so are read, not assumed.
        const [quality, metadata] = folder.serviceId === "lidarr"
          ? await Promise.all([
              this.arrApi.listQualityProfiles(folder.serviceId, base, key),
              this.arrApi.listMetadataProfiles(folder.serviceId, base, key)
            ])
          : [{ data: [] }, { data: [] }];

        const { payload, missing } = buildRootFolderPayload(folder.serviceId, folder.expectedPath, {
          qualityProfiles: quality?.data || [],
          metadataProfiles: metadata?.data || []
        });

        if (missing) {
          this.outcome.failed.push({ label: `${folder.name} library folder`, reason: missing });
          continue;
        }

        const result = await this.arrApi.createRootFolder(folder.serviceId, base, key, payload);

        if (!result.ok) {
          this.outcome.failed.push({
            label: `${folder.name} library folder`,
            reason: result.error
          });
          continue;
        }

        created.push({ serviceId: folder.serviceId, label: `${folder.name} library folder ${folder.expectedPath}` });
        logger.info("wiring.rootfolder.created", { serviceId: folder.serviceId, path: folder.expectedPath });
      }

      return { detail: this.describeOutcome(actionable.rootFolders.length, failedBefore) };
    });
  }

  async applyApplications(ctx, plan, created, skipped, logger) {
    const { actionable, current, keys } = plan;

    if (actionable.applications.length === 0) {
      ctx.skip("applications", "Prowlarr already knows about every app, or is not part of this stack.");
      return;
    }

    await ctx.step("applications", async () => {
      const failedBefore = this.outcome.failed.length;
      const base = current.get("prowlarr")?.baseUrl;
      const key = keys.get("prowlarr");
      const schema = await this.arrApi.applicationSchema(base, key);

      if (!schema.ok) {
        throw new KeelarrError(`Prowlarr would not describe its application options: ${schema.error}`, {
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

      return { detail: this.describeOutcome(actionable.applications.length, failedBefore) };
    });
  }

  async applyIndexerProxies(ctx, plan, created, skipped, logger) {
    const { actionable, current, keys } = plan;

    if (actionable.proxies.length === 0) {
      ctx.skip("proxies", "Prowlarr already has its challenge solver, or FlareSolverr is not part of this stack.");
      return;
    }

    await ctx.step("proxies", async () => {
      const failedBefore = this.outcome.failed.length;
      const base = current.get("prowlarr")?.baseUrl;
      const key = keys.get("prowlarr");
      const schema = await this.arrApi.indexerProxySchema(base, key);

      if (!schema.ok) {
        throw new KeelarrError(`Prowlarr would not describe its proxy options: ${schema.error}`, { statusCode: 502 });
      }

      for (const link of actionable.proxies) {
        const payload = buildIndexerProxyPayload(schema.data, { host: link.address.baseUrl });

        await this.writeChecked({
          label: "Prowlarr → FlareSolverr",
          test: () => this.arrApi.testIndexerProxy(base, key, payload),
          create: () => this.arrApi.createIndexerProxy(base, key, payload),
          serviceId: "prowlarr",
          created,
          logger
        });
      }

      // Creating the proxy is the whole of what Keelarr can honestly do here.
      // Prowlarr only routes an indexer through it when the two share a tag,
      // and which indexers need that is a judgement about specific trackers —
      // tagging them all would put a headless browser in front of indexers that
      // work fine without one.
      skipped.push("FlareSolverr is registered, but tag the indexers that need it in Prowlarr for it to be used.");

      return { detail: this.describeOutcome(actionable.proxies.length, failedBefore) };
    });
  }

  /**
   * Points Bazarr at the apps whose libraries it subtitles.
   *
   * One settings write rather than one per link: Bazarr holds them in a single
   * document, and patching it twice would mean reading back between writes to
   * avoid the second undoing the first.
   */
  async applySubtitleLinks(ctx, plan, created, logger) {
    const { actionable, current, keys } = plan;

    if (actionable.subtitles.length === 0) {
      ctx.skip("subtitles", "Bazarr already points at the library apps, or is not part of this stack.");
      return;
    }

    await ctx.step("subtitles", async () => {
      const failedBefore = this.outcome.failed.length;
      const base = current.get("bazarr")?.baseUrl;
      const key = keys.get("bazarr");
      // Flat `settings-<section>-<field>` keys: the shape Bazarr's own UI posts,
      // and the only one it acts on.
      const params = {};
      const wanted = [];

      for (const link of actionable.subtitles) {
        const targetKey = keys.get(link.target);

        if (!targetKey) {
          this.outcome.failed.push({
            label: `Bazarr → ${link.targetName}`,
            reason: `${link.targetName}'s API key could not be read, so Bazarr cannot be pointed at it.`
          });
          continue;
        }

        Object.assign(params, {
          [`settings-general-use_${link.target}`]: "true",
          [`settings-${link.target}-ip`]: link.address.host,
          [`settings-${link.target}-port`]: String(link.address.port),
          [`settings-${link.target}-apikey`]: targetKey,
          [`settings-${link.target}-ssl`]: "false",
          [`settings-${link.target}-base_url`]: "/"
        });
        wanted.push(link);
      }

      if (wanted.length === 0) {
        return { detail: this.describeOutcome(actionable.subtitles.length, failedBefore) };
      }

      const result = await this.bazarrApi.updateSettings(base, key, params);

      if (!result.ok) {
        for (const link of wanted) {
          this.outcome.failed.push({ label: `Bazarr → ${link.targetName}`, reason: result.error });
        }

        return { detail: this.describeOutcome(actionable.subtitles.length, failedBefore) };
      }

      // Read back rather than trust the status. Bazarr answers 204 whether or
      // not it applied anything — a nested-JSON body is accepted and silently
      // discarded — so a success here would otherwise be a claim, not a fact.
      const after = await this.bazarrApi.getSettings(base, key);

      for (const link of wanted) {
        const applied = after.ok
          && after.data?.general?.[`use_${link.target}`] === true
          && String(after.data?.[link.target]?.ip) === String(link.address.host);

        if (applied) {
          created.push({ serviceId: "bazarr", label: `Bazarr → ${link.targetName}` });
          logger.info("wiring.created", { label: `Bazarr → ${link.targetName}` });
        } else {
          this.outcome.failed.push({
            label: `Bazarr → ${link.targetName}`,
            reason: after.ok
              ? "Bazarr accepted the change but did not apply it."
              : `Bazarr accepted the change but could not be read back: ${after.error}`
          });
        }
      }

      return { detail: this.describeOutcome(actionable.subtitles.length, failedBefore) };
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
  async writeChecked({ label, test, create, serviceId, created, logger, note = null }) {
    const tested = await test();
    const rejection = tested.ok ? describeValidation(tested.data) : tested.error;

    if (rejection) {
      // Recorded, not thrown. Lidarr being refused should not stop Radarr and
      // Sonarr from being configured in the same run.
      this.outcome.failed.push({ label, reason: rejection });
      logger.warn("wiring.refused", { label, reason: rejection });
      return;
    }

    const result = await create();

    if (!result.ok) {
      this.outcome.failed.push({ label, reason: result.error });
      logger.warn("wiring.write_failed", { label, reason: result.error });
      return;
    }

    created.push({ serviceId, label });

    if (note) {
      this.outcome.notes.push(note);
    }

    logger.info("wiring.created", { label });
  }

  /**
   * Reads as a sentence whether everything in this step worked, some of it did,
   * or none. Scoped to the step by taking the failure count from before it ran,
   * so a later step does not report an earlier one's problems as its own.
   */
  describeOutcome(attempted, failedBefore = 0) {
    const mine = this.outcome.failed.slice(failedBefore);

    if (mine.length === 0) {
      return `Configured ${attempted}.`;
    }

    return `Configured ${attempted - mine.length} of ${attempted}. ${mine
      .map((entry) => `${entry.label}: ${entry.reason}`)
      .join("; ")}`;
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
        indexerProxies: [],
        tests: null
      };

      if (service.id === "bazarr") {
        if (key && link.ok) {
          const settings = await this.bazarrApi.getSettings(link.baseUrl, key);
          entry.reachable = settings.ok;
          entry.error = settings.ok ? null : settings.error;
          entry.bazarrSettings = settings.data || null;
          // Counted, not read: which languages someone wants is their choice,
          // and having none is why a fully wired Bazarr still does nothing.
          const profiles = await this.bazarrApi.getLanguageProfiles(link.baseUrl, key);
          entry.languageProfiles = profiles.ok ? (profiles.data || []).length : null;
        } else {
          entry.error = link.ok ? null : link.reason;
        }

        current.set(service.id, entry);
        continue;
      }

      // Neither of these speaks the Arr API, and both answer the one question
      // that decides whether they need something from the operator. Without
      // this the prerequisite could never fire, which is worse than not having
      // written it: a check that silently always passes.
      if (service.id === "qbittorrent" && link.ok) {
        const probe = await this.probeQbittorrent(link.baseUrl);
        entry.reachable = probe.reachable;
        entry.credentialsKnown = probe.credentialsKnown;
        entry.error = probe.error;
        current.set(service.id, entry);
        continue;
      }

      if (service.id === "jellyfin" && link.ok) {
        const probe = await this.probeJellyfin(link.baseUrl);
        entry.reachable = probe.reachable;
        entry.setupComplete = probe.setupComplete;
        entry.version = probe.version;
        entry.error = probe.error;
        current.set(service.id, entry);
        continue;
      }

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
        const [applications, indexers, proxies] = await Promise.all([
          this.arrApi.listApplications(link.baseUrl, key),
          this.countIndexers(service.id, link.baseUrl, key),
          // Proxies are optional in both directions: an older Prowlarr may not
          // offer the collection, and an injected client may not implement it.
          // No proxies is the right answer either way, and never a reason to
          // fail the whole check.
          typeof this.arrApi.listIndexerProxies === "function"
            ? this.arrApi.listIndexerProxies(link.baseUrl, key).catch(() => ({ data: [] }))
            : Promise.resolve({ data: [] })
        ]);
        entry.applications = applications.data || [];
        entry.indexerProxies = proxies.data || [];
        entry.indexerCount = indexers;
        entry.tests = await this.runTests(() => this.arrApi.testAllApplications(link.baseUrl, key));
      } else {
        const [clients, folders, indexers] = await Promise.all([
          this.arrApi.listDownloadClients(service.id, link.baseUrl, key),
          this.arrApi.listRootFolders(service.id, link.baseUrl, key),
          this.countIndexers(service.id, link.baseUrl, key)
        ]);
        entry.downloadClients = clients.data || [];
        entry.rootFolders = folders.data || [];
        entry.indexerCount = indexers;
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
   * How many indexers an app has. Null when it cannot be determined, which the
   * prerequisite check reads as "no opinion" rather than "none" — claiming an
   * app has no indexers because a call failed would send the operator hunting
   * for a problem that is not there.
   */
  async countIndexers(serviceId, baseUrl, key) {
    if (typeof this.arrApi.listIndexers !== "function") {
      return null;
    }

    const result = await this.arrApi.listIndexers(serviceId, baseUrl, key);
    return result?.ok ? (result.data || []).length : null;
  }

  /**
   * Reads the few things only the operator can supply, so the report can say
   * what is missing. Counted or checked for presence, never read: an indexer
   * key and a Usenet password are the operator's, and Keelarr has no use for
   * their values.
   */
  async readPrerequisiteState(services, current, keys, settings, logger) {
    const downloader = services.find((service) => service.id === "sabnzbd");

    if (downloader && keys.get("sabnzbd") && current.get("sabnzbd")?.baseUrl && this.sabnzbdApi.countServers) {
      const servers = await this.sabnzbdApi.countServers(current.get("sabnzbd").baseUrl, keys.get("sabnzbd"));
      current.get("sabnzbd").serverCount = servers.ok ? servers.data : null;
      current.get("sabnzbd").reachable = servers.ok;
    }

    const analytics = services.find((service) => service.id === "tautulli");

    if (analytics) {
      // Tautulli keeps its Plex link in a plain ini, so presence is readable
      // without touching the token itself.
      const text = await this.readContainerFile(settings, analytics.containerName, "/config/config.ini", { logger });
      const entry = current.get("tautulli") || {};
      entry.plexLinked = text === null ? null : /^\s*pms_ip\s*=\s*\S+/m.test(text);
      entry.reachable = text !== null;
      current.set("tautulli", entry);
    }
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
          return { ...base, ...unreadable(app, `Keelarr could not read ${service.name}'s configuration.`) };
        }

        const link = resolveLink(endpoints.get(service.id), endpoints.get("sabnzbd"), { hostAddress });

        if (!link.ok) {
          return {
            ...base,
            // The download client is the far end here, so it is the one whose
            // startup decides between "not yet" and "not at all".
            ...this.linkNotReady(endpoints.get("sabnzbd"), link.reason, "SABnzbd"),
            address: null
          };
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
        return { ...base, ...unreadable(app, "Keelarr could not read Prowlarr's configuration.") };
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

  /**
   * FlareSolverr is only useful to Prowlarr, and only once Prowlarr knows where
   * it is. Deploying it and stopping there looks like success and changes
   * nothing, which is the failure this link exists to make visible.
   */
  checkIndexerProxy(services, endpoints, current, hostAddress) {
    const prowlarr = services.find((service) => service.id === "prowlarr");
    const solver = services.find((service) => service.id === "flaresolverr");

    if (!prowlarr || !solver) {
      return [];
    }

    const app = current.get("prowlarr");
    const base = {
      kind: "indexer-proxy",
      title: "FlareSolverr in Prowlarr",
      // The confirmation dialog names each change with these; a link kind that
      // omits them renders "undefined → undefined" and tells the operator
      // nothing about what they are about to approve.
      sourceName: "Prowlarr",
      targetName: "FlareSolverr",
      subtitle: "Lets Prowlarr past the browser checks some indexers put in front of results.",
      serviceId: "prowlarr",
      targetId: "flaresolverr"
    };

    if (!app?.reachable) {
      return [{ ...base, ...unreadable(app, "Prowlarr could not be read."), address: null }];
    }

    const link = resolveLink(endpoints.get("prowlarr"), endpoints.get("flaresolverr"), { hostAddress });

    if (!link.ok) {
      return [{
        ...base,
        ...this.linkNotReady(endpoints.get("flaresolverr"), link.reason, "FlareSolverr"),
        address: null
      }];
    }

    const result = reconcileIndexerProxy(app.indexerProxies, {
      implementation: "FlareSolverr",
      host: link.baseUrl
    });

    return [{
      ...base,
      state: result.state,
      address: { baseUrl: link.baseUrl, strategy: link.strategy },
      addressReason: link.reason,
      changes: result.changes,
      reason: result.reason
    }];
  }

  /**
   * Bazarr talks to Radarr and Sonarr to know what needs subtitles. It keeps
   * each as a block of settings rather than an entry in a collection, so the
   * address goes over as separate host and port fields.
   */
  checkBazarrLinks(services, endpoints, current, hostAddress) {
    const bazarr = services.find((service) => service.id === "bazarr");

    if (!bazarr) {
      return [];
    }

    const app = current.get("bazarr");

    return services
      .filter((service) => ["radarr", "sonarr"].includes(service.id))
      .map((service) => {
        const base = {
          id: `bazarr->${service.id}:subtitles`,
          kind: "subtitle-source",
          source: "bazarr",
          sourceName: "Bazarr",
          target: service.id,
          targetName: service.name
        };

        if (!app?.reachable) {
          return { ...base, ...unreadable(app, "Keelarr could not read Bazarr's configuration.") };
        }

        const link = resolveLink(endpoints.get("bazarr"), endpoints.get(service.id), { hostAddress });

        if (!link.ok) {
          return { ...base, state: "blocked", reason: link.reason, address: null };
        }

        const result = reconcileSettingsLink({
          enabled: app.bazarrSettings?.general?.[`use_${service.id}`] === true,
          current: app.bazarrSettings?.[service.id],
          desired: { ip: link.host, port: link.port },
          describe: `${service.name} in Bazarr`
        });

        return {
          ...base,
          state: result.state,
          address: { baseUrl: link.baseUrl, host: link.host, port: link.port, strategy: link.strategy },
          addressReason: link.reason,
          actual: result.target ? { ip: result.target.ip, port: result.target.port } : null,
          changes: result.changes,
          reason: result.reason,
          test: null
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
          return { ...base, ...unreadable(app, `Keelarr could not read ${service.name}'s configuration.`) };
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

  summarize(links, rootFolders, participants, prerequisites = []) {
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

    // Zero counts as nothing wrong, not as nothing done. A stack of one app has
    // no links to make, and requiring total > 0 here reported it as
    // "0 of 0 connections are configured: ." — a fault that does not exist.
    if (summary.correct === summary.total) {
      const wiring = summary.total > 0
        ? `All ${summary.total} connections are configured correctly`
        : "There is nothing to connect yet — one app on its own has nothing to link to";

      // Connections first, then whether the stack can actually acquire
      // anything. Both are reported, because they fail independently.
      if (prerequisites.length > 0) {
        return {
          summary,
          readiness: READINESS.NEEDS_YOU,
          readinessMessage: `${wiring}, but ${prerequisites
            .map((entry) => entry.name)
            .join(" and ")} still ${prerequisites.length === 1 ? "needs" : "need"} something only you can provide.`
        };
      }

      return {
        summary,
        readiness: READINESS.READY,
        readinessMessage: summary.total > 0
          ? `Stack ready. All ${summary.total} connections are configured correctly.`
          : "Stack ready. Nothing needs connecting yet — add another app and Keelarr will wire them together."
      };
    }

    const outstanding = [
      summary.absent && `${summary.absent} missing`,
      summary.drift && `${summary.drift} pointing elsewhere`,
      summary.ambiguous && `${summary.ambiguous} ambiguous`,
      // Named explicitly, or the count simply would not add up on screen.
      summary.unknown && `${summary.unknown} that Keelarr could not read`
    ].filter(Boolean);

    return {
      summary,
      readiness: READINESS.INCOMPLETE,
      readinessMessage: `${summary.correct} of ${summary.total} connections are configured: ${outstanding.join(", ")}.${
        prerequisites.length ? ` ${prerequisites.length} thing${prerequisites.length === 1 ? "" : "s"} also need${prerequisites.length === 1 ? "s" : ""} you.` : ""
      }`
    };
  }
}
