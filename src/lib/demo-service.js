import {
  buildImportDraftArtifacts,
  buildImportPreview,
  buildImportReviewArtifacts
} from "./import-planner.js";
import { APP_NAME, APP_VERSION } from "./app-meta.js";
import { normalizeSettings } from "./store.js";
import { listServices } from "./service-catalog.js";
import { KeelarrError } from "./errors.js";
import { JobRegistry, buildJobSnapshot } from "./jobs.js";
import { CUTOVER_STEPS, REVERT_STEPS, rollbackNameFor } from "./app-services/cutover-service.js";
import { WIRING_STEPS } from "./app-services/wiring-service.js";

function clone(value) {
  return structuredClone(value);
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeDemoInput(input = {}) {
  const next = { ...input };
  delete next.deploy;
  delete next.preferredAdapterId;
  return next;
}

function summarizeImports(items) {
  return {
    totalContainers: items.length,
    recognized: items.filter((item) => item.recognized).length,
    adoptable: items.filter((item) => item.adoptable).length,
    needsReview: items.filter((item) => item.issues.some((issue) => issue.level !== "info")).length,
    drafted: items.filter((item) => item.adoptedDraft === true).length
  };
}

function createDemoDetection(draftSettings = {}) {
  const settings = normalizeSettings({
    initialized: true,
    adapterType: "generic-docker",
    hostLabel: "Generic Docker Host",
    dockerBin: "docker",
    stackRoot: "/srv/keelarr/stacks",
    configRoot: "/srv/keelarr/config",
    mediaRoot: "/srv/media",
    downloadsRoot: "/srv/media/downloads",
    plexLogsRoot: "",
    hostUrl: "http://localhost",
    tz: "America/Chicago",
    puid: "1000",
    pgid: "1000",
    ombiVersion: "latest",
    selectedServiceIds: ["prowlarr", "radarr", "sonarr", "bazarr", "trailarr", "ombi", "tautulli", "sabnzbd"],
    ...draftSettings
  });

  const selected = {
    adapterId: "generic-docker",
    label: "Generic Docker Host",
    matched: true,
    score: 95,
    confidence: "high",
    notes: [
      "Docker is available on the demo host and Compose commands validate successfully.",
      "The suggested paths reflect a generic Linux media stack."
    ],
    validation: {
      dockerOk: true,
      composeOk: true,
      stackRootWritable: true
    },
    suggestedSettings: {
      adapterType: settings.adapterType,
      hostLabel: settings.hostLabel,
      dockerBin: settings.dockerBin,
      stackRoot: settings.stackRoot,
      configRoot: settings.configRoot,
      mediaRoot: settings.mediaRoot,
      downloadsRoot: settings.downloadsRoot,
      plexLogsRoot: settings.plexLogsRoot
    },
    fieldSuggestions: {
      dockerBin: { value: settings.dockerBin, confidence: "high", source: "demo-generic-profile", note: "validated" },
      stackRoot: { value: settings.stackRoot, confidence: "high", source: "demo-generic-profile", note: "validated" },
      configRoot: { value: settings.configRoot, confidence: "high", source: "demo-generic-profile", note: "validated" },
      mediaRoot: { value: settings.mediaRoot, confidence: "high", source: "demo-generic-profile", note: "validated" },
      downloadsRoot: { value: settings.downloadsRoot, confidence: "high", source: "demo-generic-profile", note: "validated" },
      plexLogsRoot: { value: settings.plexLogsRoot, confidence: "low", source: "demo-generic-profile", note: "unset" }
    },
    diagnostics: [
      {
        binaryPath: settings.dockerBin,
        dockerOk: true,
        composeOk: true,
        dockerVersion: "29.4.1",
        composeVersion: "Docker Compose version v5.1.3",
        error: null
      }
    ]
  };

  return {
    selected,
    detections: [
      selected,
      {
        adapterId: "qnap",
        label: "QNAP / Container Station",
        matched: true,
        score: 66,
        confidence: "medium",
        notes: [
          "A QNAP profile could also be used for a NAS-oriented deployment.",
          "The generic Docker profile is the stronger fit in this demo."
        ],
        validation: {
          dockerOk: true,
          composeOk: true,
          stackRootWritable: true
        },
        suggestedSettings: {
          adapterType: "qnap",
          hostLabel: "QNAP NAS",
          dockerBin: "/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker",
          stackRoot: "/share/Container/docker",
          configRoot: "/share/Container",
          mediaRoot: "/share/Media",
          downloadsRoot: "/share/Media/Downloads",
          plexLogsRoot: "/share/Container/plex/Logs"
        },
        fieldSuggestions: {
          dockerBin: { value: "/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker", confidence: "medium", source: "demo-qnap-profile", note: null },
          stackRoot: { value: "/share/Container/docker", confidence: "medium", source: "demo-qnap-profile", note: null },
          configRoot: { value: "/share/Container", confidence: "medium", source: "demo-qnap-profile", note: null },
          mediaRoot: { value: "/share/Media", confidence: "medium", source: "demo-qnap-profile", note: null },
          downloadsRoot: { value: "/share/Media/Downloads", confidence: "medium", source: "demo-qnap-profile", note: null },
          plexLogsRoot: { value: "/share/Container/plex/Logs", confidence: "medium", source: "demo-qnap-profile", note: null }
        },
        diagnostics: []
      }
    ]
  };
}

function selectDemoDetection(detection, preferredAdapterId = null) {
  if (!preferredAdapterId) {
    return detection;
  }

  const selected = detection.detections.find((item) => item.adapterId === preferredAdapterId) || detection.selected;
  return {
    ...detection,
    selected
  };
}

function createDemoScenario() {
  const settings = normalizeSettings({
    initialized: true,
    projectName: "Keelarr",
    adapterType: "generic-docker",
    hostLabel: "Generic Docker Host",
    dockerBin: "docker",
    stackRoot: "/srv/keelarr/stacks",
    configRoot: "/srv/keelarr/config",
    mediaRoot: "/srv/media",
    downloadsRoot: "/srv/media/downloads",
    plexLogsRoot: "",
    hostUrl: "http://localhost",
    tz: "America/Chicago",
    puid: "1000",
    pgid: "1000",
    ombiVersion: "latest",
    selectedServiceIds: ["prowlarr", "radarr", "sonarr", "bazarr", "trailarr", "ombi", "tautulli", "sabnzbd"]
  });

  return {
    settings,
    detection: createDemoDetection(settings),
    activity: [
      {
        id: crypto.randomUUID(),
        at: "2026-08-04T22:22:38.000Z",
        kind: "update-check-all",
        level: "info",
        message: "Checked update status across the selected stack."
      },
      {
        id: crypto.randomUUID(),
        at: "2026-08-04T22:19:02.000Z",
        kind: "setup",
        level: "info",
        message: "Saved host config draft without deploying."
      },
      {
        id: crypto.randomUUID(),
        at: "2026-08-04T22:18:44.000Z",
        kind: "host-detect",
        level: "info",
        message: "Detected host defaults for Generic Docker Host."
      },
      {
        id: crypto.randomUUID(),
        at: "2026-08-04T22:17:11.000Z",
        kind: "docker-scan",
        level: "info",
        message: "Read-only scan found no unmanaged containers."
      }
    ],
    services: {
      prowlarr: { generated: false, runtimeStatus: "not-deployed", reachable: false, httpStatus: null, latencyMs: null, updateStatus: "unknown" },
      radarr: { generated: false, runtimeStatus: "not-deployed", reachable: false, httpStatus: null, latencyMs: null, updateStatus: "unknown" },
      sonarr: { generated: false, runtimeStatus: "not-deployed", reachable: false, httpStatus: null, latencyMs: null, updateStatus: "unknown" },
      bazarr: { generated: false, runtimeStatus: "not-deployed", reachable: false, httpStatus: null, latencyMs: null, updateStatus: "unknown" },
      trailarr: { generated: false, runtimeStatus: "not-deployed", reachable: false, httpStatus: null, latencyMs: null, updateStatus: "unknown" },
      ombi: { generated: false, runtimeStatus: "not-deployed", reachable: false, httpStatus: null, latencyMs: null, updateStatus: "unknown" },
      tautulli: { generated: false, runtimeStatus: "not-deployed", reachable: false, httpStatus: null, latencyMs: null, updateStatus: "unknown" },
      sabnzbd: { generated: false, runtimeStatus: "not-deployed", reachable: false, httpStatus: null, latencyMs: null, updateStatus: "unknown" }
    },
    importItems: [
      {
        containerId: "trailarrdemo",
        containerName: "trailarr",
        image: "nandyalu/trailarr:latest",
        recognized: true,
        serviceId: "trailarr",
        serviceName: "Trailarr",
        matchedBy: "name",
        status: "running",
        restartPolicy: "unless-stopped",
        networkMode: "bridge",
        networks: [{ name: "bridge", address: "203.0.113.7" }],
        ports: [{ containerPort: "7889/tcp", hostIp: "0.0.0.0", hostPort: "7889", display: "0.0.0.0:7889->7889/tcp" }],
        mounts: [
          { type: "bind", source: "/share/Container/trailarr/config", target: "/config", mode: "rw", name: null },
          { type: "bind", source: "/share/Media", target: "/Media", mode: "rw", name: null }
        ],
        envKeys: ["PGID", "PUID", "TZ"],
        command: [],
        entrypoint: ["/app/scripts/entrypoint.sh"],
        issues: [],
        adoptable: true,
        adoptedDraft: false
      },
      {
        containerId: "ombidemo12345",
        containerName: "ombi",
        image: "lscr.io/linuxserver/ombi:development",
        recognized: true,
        serviceId: "ombi",
        serviceName: "Ombi",
        matchedBy: "image",
        status: "running",
        restartPolicy: "unless-stopped",
        networkMode: "bridge",
        networks: [{ name: "bridge", address: "203.0.113.2" }],
        ports: [{ containerPort: "3579/tcp", hostIp: "0.0.0.0", hostPort: "3579", display: "0.0.0.0:3579->3579/tcp" }],
        mounts: [
          { type: "bind", source: "/share/Container/ombi/config", target: "/config", mode: "rw", name: null }
        ],
        envKeys: ["PGID", "PUID", "TZ", "VERSION"],
        command: [],
        entrypoint: ["/init"],
        issues: [
          {
            level: "info",
            message: "The live container is using a development tag while the Keelarr default tracks latest."
          }
        ],
        adoptable: true,
        adoptedDraft: false
      },
      {
        containerId: "tautullidemo1",
        containerName: "tautulli",
        image: "ghcr.io/tautulli/tautulli:latest",
        recognized: true,
        serviceId: "tautulli",
        serviceName: "Tautulli",
        matchedBy: "name",
        status: "running",
        restartPolicy: "unless-stopped",
        networkMode: "bridge",
        networks: [{ name: "bridge", address: "203.0.113.6" }],
        ports: [{ containerPort: "8181/tcp", hostIp: "0.0.0.0", hostPort: "8181", display: "0.0.0.0:8181->8181/tcp" }],
        mounts: [
          { type: "bind", source: "/share/Container/tautulli/config", target: "/config", mode: "rw", name: null }
        ],
        envKeys: ["PGID", "PUID", "TZ"],
        command: ["python", "Tautulli.py", "--datadir", "/config"],
        entrypoint: ["./start.sh"],
        issues: [
          {
            level: "error",
            message: "Missing expected /plex_logs mount for Tautulli."
          }
        ],
        adoptable: false,
        adoptedDraft: false
      },
      {
        containerId: "watchtowerdemo",
        containerName: "watchtower",
        image: "containrrr/watchtower:latest",
        recognized: false,
        serviceId: null,
        serviceName: null,
        matchedBy: null,
        status: "running",
        restartPolicy: "unless-stopped",
        networkMode: "bridge",
        networks: [{ name: "bridge", address: "203.0.113.9" }],
        ports: [],
        mounts: [],
        envKeys: ["WATCHTOWER_CLEANUP", "WATCHTOWER_SCHEDULE"],
        command: [],
        entrypoint: [],
        issues: [
          {
            level: "warn",
            message: "Container is not currently mapped to a Keelarr-supported service."
          }
        ],
        adoptable: false,
        adoptedDraft: false
      }
    ]
  };
}

const demoBrowseTree = new Map([
  ["/", ["share", "srv", "opt"]],
  ["/share", ["Container", "Media"]],
  ["/share/Container", ["docker", "plex", "trailarr", "ombi", "tautulli"]],
  ["/share/Container/plex", ["Logs"]],
  ["/share/Media", ["Downloads", "Movies", "TV"]],
  ["/srv", ["keelarr", "media"]],
  ["/srv/keelarr", ["config", "stacks"]],
  ["/srv/media", ["downloads", "movies", "tv"]]
]);

function browseDemoDirectories(inputPath = "/") {
  const targetPath = inputPath === "/" ? "/" : `/${String(inputPath || "").replace(/^\/+|\/+$/g, "")}`;
  const children = demoBrowseTree.get(targetPath);

  if (!children) {
    throw new KeelarrError(`Unable to browse ${targetPath}.`, {
      statusCode: 404,
      details: {
        code: "ENOENT",
        path: targetPath
      }
    });
  }

  return {
    ok: true,
    path: targetPath,
    parentPath: targetPath === "/" ? null : targetPath.split("/").slice(0, -1).join("/") || "/",
    directories: children.map((name) => ({
      name,
      path: targetPath === "/" ? `/${name}` : `${targetPath}/${name}`
    }))
  };
}

function buildDemoDiagnostics(settings) {
  const diagnostics = [];

  if (!settings.downloadsRoot.startsWith(settings.mediaRoot)) {
    diagnostics.push({
      level: "warn",
      message: "Downloads root is outside the media root. Hardlinks and atomic moves may fail."
    });
  }

  if (settings.selectedServiceIds.includes("tautulli") && !settings.plexLogsRoot) {
    diagnostics.push({
      level: "warn",
      message: "Tautulli is enabled but Plex logs path is empty."
    });
  }

  diagnostics.push({
    level: "info",
    message: "All Docker operations are simulated and no real containers are changed."
  });

  return diagnostics;
}

export class DemoKeelarrAppService {
  constructor() {
    // The demo drives the real registry so the job polling contract is
    // identical to live mode; only the Docker work underneath is simulated.
    this.jobs = new JobRegistry();
    this.resetScenario();
  }

  resetScenario() {
    this.demo = createDemoScenario();
  }

  async buildState() {
    const settings = normalizeSettings(this.demo.settings);
    const services = settings.selectedServiceIds.map((serviceId) => {
      const service = settings.services[serviceId];
      const runtime = this.demo.services[serviceId] || {
        generated: false,
        runtimeStatus: "not-deployed",
        reachable: false,
        httpStatus: null,
        latencyMs: null,
        updateStatus: "unchecked"
      };

      // Mirror the derivation in status.js so the demo dashboard shows the
      // same management lifecycle the live one does.
      const inventoryItem = this.demo.importItems?.find(
        (item) => item.recognized && item.serviceId === serviceId
      ) || null;
      const managementState = runtime.managed
        ? "managed"
        : runtime.generated && inventoryItem
          ? "draft"
          : inventoryItem
            ? "detected"
            : runtime.generated
              ? "generated"
              : "catalog";

      return {
        ...service,
        appUrl: `/demo/apps/${service.id}`,
        generated: runtime.generated,
        managementState,
        managedMode: runtime.managed ? "imported" : inventoryItem && runtime.generated ? "imported-draft" : "catalog",
        runtimeSource: runtime.managed ? "compose" : inventoryItem ? "inventory" : "none",
        rollbackContainerName: runtime.rollbackContainerName || null,
        cutoverAt: runtime.cutoverAt || null,
        observedContainerId: inventoryItem?.containerId || null,
        observedContainerName: inventoryItem?.containerName || service.containerName,
        runtimeStatus: runtime.runtimeStatus,
        publishings: runtime.publishings || [],
        reachable: runtime.reachable,
        httpStatus: runtime.httpStatus,
        latencyMs: runtime.latencyMs,
        lastError: runtime.lastError || null,
        updateStatus: runtime.updateStatus,
        updateCheckedAt: runtime.updateCheckedAt || null
      };
    });

    return {
      ok: true,
      configured: true,
      settings,
      services,
      diagnostics: buildDemoDiagnostics(settings),
      activity: clone(this.demo.activity),
      catalog: listServices(),
      hostDetection: clone(this.demo.detection),
      meta: {
        appName: APP_NAME,
        version: APP_VERSION,
        mode: "demo",
        label: "Interactive Demo",
        note: "All dashboard actions are simulated. No Docker host is modified.",
        selfUpdate: this.describeDemoSelfUpdate()
      }
    };
  }

  /**
   * The demo has no container behind it, so self-update is shown exactly as it
   * would be on a host that cannot do it: the release is named, and the reason
   * it is not on offer is stated rather than the button being silently absent.
   */
  describeDemoSelfUpdate() {
    return {
      currentVersion: APP_VERSION,
      targetVersion: APP_VERSION,
      updateStatus: "current",
      checkedAt: new Date().toISOString(),
      checkError: null,
      supported: false,
      available: false,
      reason: "The demo has no container to replace.",
      checks: [{ id: "container", label: "Keelarr can see its own container", ok: false, reason: "The demo has no container to replace." }]
    };
  }

  async describeSelfUpdate() {
    return { ok: true, selfUpdate: this.describeDemoSelfUpdate() };
  }

  async checkSelfUpdate() {
    return { ok: true, selfUpdate: this.describeDemoSelfUpdate() };
  }

  async detectHost(input = null) {
    const preferredAdapterId = input?.preferredAdapterId || input?.adapterType || null;
    const nextSettings = input
      ? normalizeSettings({
          ...this.demo.settings,
          ...sanitizeDemoInput(input),
          initialized: true
        })
      : this.demo.settings;

    return selectDemoDetection(createDemoDetection(nextSettings), preferredAdapterId);
  }

  async saveSettings(input = {}) {
    const preferredAdapterId = input?.preferredAdapterId || input?.adapterType || null;
    this.demo.settings = normalizeSettings({
      ...this.demo.settings,
      ...sanitizeDemoInput(input),
      initialized: true
    });
    this.demo.detection = selectDemoDetection(createDemoDetection(this.demo.settings), preferredAdapterId);
    this.pushActivity({
      kind: "settings-save",
      level: "info",
      message: "Saved host settings."
    });

    return {
      ...(await this.buildState()),
      generated: [],
      hostDetection: clone(this.demo.detection),
      validation: clone(this.demo.detection.validation),
      effectiveSettings: clone(this.demo.settings),
      settings: clone(this.demo.settings)
    };
  }

  async setup(input = {}) {
    const deploy = input?.deploy === true;
    const rawSettings = sanitizeDemoInput(input);
    const preferredAdapterId = input?.preferredAdapterId || input?.adapterType || null;

    this.demo.settings = normalizeSettings({
      ...this.demo.settings,
      ...rawSettings,
      initialized: true
    });
    this.demo.detection = selectDemoDetection(createDemoDetection(this.demo.settings), preferredAdapterId);

    for (const serviceId of this.demo.settings.selectedServiceIds) {
      const runtime = this.demo.services[serviceId] || {
        generated: false,
        runtimeStatus: "not-deployed",
        reachable: false,
        httpStatus: null,
        latencyMs: null,
        updateStatus: "unchecked"
      };

      runtime.generated = true;
      if (deploy) {
        runtime.runtimeStatus = "running";
        runtime.reachable = true;
        runtime.httpStatus = 200;
        runtime.latencyMs = runtime.latencyMs || 60;
      }
      this.demo.services[serviceId] = runtime;
    }

    this.pushActivity({
      kind: "setup",
      level: "info",
      message: `Generated ${this.demo.settings.selectedServiceIds.length} stack folder(s).`
    });

    const state = await this.buildState();
    return {
      ...state,
      generated: this.demo.settings.selectedServiceIds.map((serviceId) => ({
        serviceId,
        composePath: `${state.settings.services[serviceId].stackDir}/compose.yml`,
        envPath: `${state.settings.services[serviceId].stackDir}/.env`
      })),
      deployResults: deploy
        ? this.demo.settings.selectedServiceIds.map((serviceId) => ({
            serviceId,
            ok: true,
            output: `Deploy completed for ${serviceId}.`
          }))
        : []
    };
  }

  async scanImportInventory() {
    const items = clone(this.demo.importItems);
    return {
      ok: true,
      scannedAt: nowIso(),
      summary: summarizeImports(items),
      items
    };
  }

  async browseDirectories(inputPath = "/") {
    return browseDemoDirectories(inputPath);
  }

  async previewImport(containerId) {
    const item = this.findImportCandidate(containerId);
    return buildImportPreview(this.demo.settings, item, {
      demo: true
    });
  }

  async adoptImportAsDraft(containerId) {
    const item = this.findImportCandidate(containerId);
    if (!item.adoptable || !item.serviceId) {
      throw new KeelarrError("This demo container is not ready for managed draft adoption.", {
        statusCode: 400
      });
    }

    if (!this.demo.settings.selectedServiceIds.includes(item.serviceId)) {
      this.demo.settings = normalizeSettings({
        ...this.demo.settings,
        selectedServiceIds: [...this.demo.settings.selectedServiceIds, item.serviceId],
        initialized: true
      });
    }

    const runtime = this.demo.services[item.serviceId] || {
      generated: false,
      runtimeStatus: "not-deployed",
      reachable: false,
      httpStatus: null,
      latencyMs: null,
      updateStatus: "unchecked"
    };
    runtime.generated = true;
    this.demo.services[item.serviceId] = runtime;
    item.adoptedDraft = true;

    this.pushActivity({
      kind: "import-draft",
      level: "info",
      message: `Generated a managed draft for ${item.serviceName} from ${item.containerName}.`
    });

    const preview = await buildImportPreview(this.demo.settings, item, { demo: true });
    const reviewArtifacts = buildImportReviewArtifacts(preview, nowIso());
    const draft = {
      ...buildImportDraftArtifacts(this.demo.settings, item),
      reviewSummary: reviewArtifacts.summary,
      reviewNotes: reviewArtifacts.markdown
    };

    return {
      ok: true,
      preview,
      generated: {
        serviceId: draft.serviceId,
        composePath: draft.composePath,
        envPath: draft.envPath,
        envExamplePath: draft.envExamplePath,
        reviewSummaryPath: `${draft.stackDir}/import-summary.json`,
        reviewNotesPath: `${draft.stackDir}/IMPORT-REVIEW.md`
      },
      state: await this.buildState()
    };
  }

  async startCutover(containerId, input = {}) {
    const item = this.findImportCandidate(containerId);

    if (!item.adoptedDraft) {
      throw new KeelarrError("Generate the managed draft before running a demo cutover.", {
        statusCode: 409
      });
    }

    if (input.confirmContainerName !== item.containerName) {
      throw new KeelarrError(
        `Cutover confirmation does not match. Expected the container name ${item.containerName}.`,
        { statusCode: 400 }
      );
    }

    const rollbackName = rollbackNameFor(item.containerName);
    const job = this.jobs.create({
      kind: "cutover",
      subject: { containerId },
      steps: CUTOVER_STEPS
    });

    this.jobs.start(job, async (ctx) => {
      for (const name of ["preflight", "backup", "stop", "rename", "deploy", "verify"]) {
        await ctx.step(name, async () => ({ detail: `Simulated ${name} for ${item.containerName}.` }));
      }

      ctx.skip("revert", "Not needed.");

      await ctx.step("finalize", async () => {
        const runtime = this.demo.services[item.serviceId] || {};
        runtime.generated = true;
        runtime.managed = true;
        runtime.runtimeStatus = "running";
        runtime.reachable = true;
        runtime.updateStatus = "unchecked";
        runtime.rollbackContainerName = rollbackName;
        runtime.cutoverAt = nowIso();
        this.demo.services[item.serviceId] = runtime;
        item.cutOver = true;

        this.pushActivity({
          kind: "cutover",
          level: "info",
          message: `Cut over ${item.serviceName} to Compose management.`
        });

        return { detail: `${item.serviceName} is now Compose-managed.` };
      });

      return {
        outcome: "verified",
        serviceId: item.serviceId,
        serviceName: item.serviceName,
        containerName: item.containerName,
        rollbackContainerName: rollbackName,
        cleanupHint: `The original container is preserved as ${rollbackName}.`
      };
    });

    return {
      ok: true,
      job: buildJobSnapshot(job)
    };
  }

  async startCutoverRevert(serviceId, input = {}) {
    const settings = normalizeSettings(this.demo.settings);
    const service = this.requireService(settings, serviceId);

    if (input.confirmContainerName !== service.containerName) {
      throw new KeelarrError(
        `Revert confirmation does not match. Expected the container name ${service.containerName}.`,
        { statusCode: 400 }
      );
    }

    const job = this.jobs.create({
      kind: "cutover-revert",
      subject: { serviceId },
      steps: REVERT_STEPS
    });

    this.jobs.start(job, async (ctx) => {
      for (const name of ["preflight", "compose-down", "restore", "verify"]) {
        await ctx.step(name, async () => ({ detail: `Simulated ${name} for ${service.containerName}.` }));
      }

      await ctx.step("finalize", async () => {
        const runtime = this.demo.services[serviceId] || {};
        runtime.managed = false;
        runtime.rollbackContainerName = null;
        runtime.cutoverAt = null;
        this.demo.services[serviceId] = runtime;

        this.pushActivity({
          kind: "cutover-revert",
          level: "warn",
          message: `Reverted ${service.name} to the original container.`
        });

        return { detail: `${service.name} is back on the original container.` };
      });

      return {
        outcome: "verified",
        serviceId,
        serviceName: service.name,
        containerName: service.containerName
      };
    });

    return {
      ok: true,
      job: buildJobSnapshot(job)
    };
  }

  async upgradeAllJob() {
    const settings = normalizeSettings(this.demo.settings);
    const services = settings.selectedServiceIds.map((id) => settings.services[id]);
    const job = this.jobs.create({
      kind: "upgrade-all",
      subject: { serviceId: "*" },
      steps: services.map((service) => ({ name: service.id, label: `Upgrade ${service.name}` }))
    });

    this.jobs.start(job, async (ctx) => {
      for (const service of services) {
        await ctx.step(service.id, async () => {
          const runtime = this.demo.services[service.id] || {};
          runtime.updateStatus = "current";
          this.demo.services[service.id] = runtime;
          return { detail: `Simulated upgrade of ${service.name}.` };
        });
      }

      this.pushActivity({ kind: "upgrade-all", level: "info", message: "Upgraded the selected stack." });
      return { upgraded: services.length, failed: 0, skipped: 0, total: services.length, summary: `${services.length} upgraded.` };
    });

    return { ok: true, job: buildJobSnapshot(job) };
  }

  /**
   * The demo stack is all one Compose project on a shared network, which is the
   * clean case: every app resolves the others by container name and nothing is
   * blocked. The messier states are exercised by the unit tests, not here.
   */
  /**
   * The demo stack always reports as fully wired, so there is never anything to
   * apply. It returns a finished job saying exactly that, the same shape the
   * live service returns — a stack that needs nothing is a success, and the
   * demo must not be the one place that calls it a failure.
   */
  async startWiring() {
    const summary = "Nothing to change — every connection is already configured.";
    const job = this.jobs.create({ kind: "wiring", subject: { scope: "stack" }, steps: WIRING_STEPS });

    this.jobs.start(job, async (ctx) => {
      await ctx.step("plan", async () => ({ detail: summary }));
      for (const step of WIRING_STEPS.slice(1)) {
        ctx.skip(step.name, "Nothing needed configuring.");
      }

      return { created: [], failed: [], notes: [], skipped: [], verification: [], changed: false, summary };
    });

    return { ok: true, job: buildJobSnapshot(job) };
  }

  async describeWiring() {
    const settings = normalizeSettings(this.demo.settings);
    const acquirers = ["radarr", "sonarr", "lidarr"].filter((id) => settings.services[id]);
    const has = (id) => Boolean(settings.services[id]);
    const folder = { radarr: "Movies", sonarr: "TV", lidarr: "Music" };
    const passed = { ran: true, ok: true, message: "1 connection test passed." };

    const links = [
      ...acquirers.map((id) => ({
        id: `${id}->sabnzbd:downloadclient`,
        kind: "download-client",
        source: id,
        sourceName: settings.services[id].name,
        target: "sabnzbd",
        targetName: "SABnzbd",
        ...(has("sabnzbd")
          ? {
              state: "correct",
              address: { baseUrl: "http://sabnzbd:8080", host: "sabnzbd", port: 8080, strategy: "shared-network" },
              addressReason: `${settings.services[id].name} and SABnzbd share the keelarr network, so SABnzbd resolves by container name.`,
              actual: { id: 1, name: "SABnzbd", enabled: true, host: "sabnzbd", port: 8080 },
              changes: [],
              reason: "The SABnzbd download client is already configured correctly.",
              test: passed
            }
          : { state: "not-applicable", reason: "SABnzbd is not part of this stack." })
      })),
      ...acquirers.map((id) => ({
        id: `prowlarr->${id}:application`,
        kind: "indexer-app",
        source: "prowlarr",
        sourceName: "Prowlarr",
        target: id,
        targetName: settings.services[id].name,
        ...(has("prowlarr")
          ? {
              state: "correct",
              address: {
                baseUrl: `http://${id}:${settings.services[id].port}`,
                prowlarrUrl: "http://prowlarr:9696",
                strategy: "shared-network"
              },
              addressReason: `Prowlarr and ${settings.services[id].name} share the keelarr network.`,
              actual: { id: 2, name: settings.services[id].name, implementation: settings.services[id].name, baseUrl: `http://${id}:${settings.services[id].port}` },
              changes: [],
              reason: `${settings.services[id].name} in Prowlarr is already configured correctly.`,
              test: passed
            }
          : { state: "not-applicable", reason: "Prowlarr is not part of this stack, so nothing syncs indexers into this app." })
      }))
    ];

    const rootFolders = acquirers.map((id) => ({
      serviceId: id,
      name: settings.services[id].name,
      state: "correct",
      expectedPath: `/Media/${folder[id]}`,
      derivedFrom: "the /Media mount",
      actual: [{ path: `/Media/${folder[id]}`, accessible: true }],
      reason: `A root folder is configured at /Media/${folder[id]}.`
    }));

    const counted = links.filter((link) => link.state !== "not-applicable").length + rootFolders.length;

    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      participants: settings.selectedServiceIds.map((id) => ({
        serviceId: id,
        name: settings.services[id].name,
        running: true,
        topology: { kind: "bridge", networkMode: "keelarr", containerPort: settings.services[id].port },
        monitoring: {
          level: "probe",
          summary: `Checked over HTTP at http://${id}:${settings.services[id].port}.`
        },
        apiKey: ["radarr", "sonarr", "lidarr", "prowlarr"].includes(id)
          ? { found: true, state: "found", source: "/config/config.xml", fingerprint: "demo1234" }
          : id === "sabnzbd"
            ? { found: true, state: "found", source: "/config/sabnzbd.ini", fingerprint: "demo5678" }
            : { found: false, state: "unsupported", reason: `Keelarr does not read an API key for ${settings.services[id].name}.` },
        controllerLink: {
          ok: true,
          baseUrl: `http://${id}:${settings.services[id].port}`,
          strategy: "shared-network",
          reason: `Keelarr and ${settings.services[id].name} share the keelarr network.`
        },
        downloads: id === "sabnzbd" ? { completeDir: "/Media/Downloads/complete", hostWhitelist: ["sabnzbd"] } : null
      })),
      links,
      rootFolders,
      // A demo stack has no indexer either, and showing that is more useful
      // than pretending every stack arrives complete.
      prerequisites: has("prowlarr")
        ? [
            {
              serviceId: "prowlarr",
              name: "Prowlarr",
              requirement: "indexer",
              summary: "Prowlarr has no indexers, so it has nothing to sync into the apps connected to it.",
              consequence: "Nothing in this stack can find releases until at least one indexer exists.",
              link: "http://localhost:9696/settings/indexers"
            }
          ]
        : [],
      pathMappings: acquirers.map((id) => ({
        serviceId: id,
        name: settings.services[id].name,
        state: "not-needed",
        mapping: null,
        reason: "The download client and this app both see completed downloads at /Media/Downloads/complete, so no mapping is required."
      })),
      summary: { total: counted, correct: counted, drift: 0, ambiguous: 0, absent: 0, blocked: 0, pending: 0, unknown: 0 },
      readiness: has("prowlarr") ? "needs-you" : "ready",
      readinessMessage: has("prowlarr")
        ? `All ${counted} connections are configured correctly, but Prowlarr still needs something only you can provide.`
        : `Stack ready. All ${counted} connections are configured correctly.`
    };
  }

  async describeRemoval(serviceId) {
    const settings = normalizeSettings(this.demo.settings);
    const service = this.requireService(settings, serviceId);
    return {
      ok: true,
      serviceId,
      serviceName: service.name,
      containerName: service.containerName,
      imported: false,
      targets: {
        container: { label: `Container ${service.containerName}`, always: true },
        stack: { label: "Generated stack files", path: service.stackDir, always: true },
        config: { label: "Configuration and database", path: service.configDir, type: "bind", size: "412M" },
        image: { label: service.image },
        backups: { label: "Keelarr backups and config snapshots", path: `${settings.stackRoot}/.keelarr-backups/${serviceId}` }
      },
      preserved: [
        { label: "Media library", path: settings.mediaRoot, reason: "Shared by every app in the stack." },
        { label: "Downloads", path: settings.downloadsRoot, reason: "Shared by every app in the stack." }
      ],
      warnings: serviceId === "prowlarr"
        ? [{ level: "warn", message: "These apps get their indexers from Prowlarr and will stop finding releases. Affected: radarr, sonarr." }]
        : []
    };
  }

  async startRemoval(serviceId, input = {}) {
    const settings = normalizeSettings(this.demo.settings);
    const service = this.requireService(settings, serviceId);

    if (input.confirmContainerName !== service.containerName) {
      throw new KeelarrError(`Removal confirmation does not match. Expected the container name ${service.containerName}.`, { statusCode: 400 });
    }

    const job = this.jobs.create({
      kind: "remove",
      subject: { serviceId },
      steps: [
        { name: "preflight", label: "Check what will be removed" },
        { name: "stop", label: "Stop and remove the container" },
        { name: "stack", label: "Delete the generated stack files" },
        { name: "finalize", label: "Remove from the dashboard" }
      ]
    });

    this.jobs.start(job, async (ctx) => {
      for (const name of ["preflight", "stop", "stack"]) {
        await ctx.step(name, async () => ({ detail: `Simulated ${name} for ${service.name}.` }));
      }
      await ctx.step("finalize", async () => {
        this.demo.settings = normalizeSettings({
          ...this.demo.settings,
          selectedServiceIds: settings.selectedServiceIds.filter((id) => id !== serviceId)
        });
        delete this.demo.services[serviceId];
        this.pushActivity({ kind: "remove", level: "warn", message: `Removed ${service.name}.` });
        return { detail: `${service.name} removed from the dashboard.` };
      });
      const kept = ["config", "image", "backups"].filter((k) => !input[`remove${k[0].toUpperCase()}${k.slice(1)}`]);
      return { serviceId, serviceName: service.name, removed: ["container", "stack"], kept, summary: kept.length ? `${service.name} removed. Kept: ${kept.join(", ")}.` : `${service.name} and all of its data were removed.` };
    });

    return { ok: true, job: buildJobSnapshot(job) };
  }

  async getJob(jobId) {
    return {
      ok: true,
      job: buildJobSnapshot(this.jobs.get(jobId))
    };
  }

  async listJobs() {
    return {
      ok: true,
      jobs: this.jobs.list().map((job) => buildJobSnapshot(job))
    };
  }

  async generateServiceFiles(serviceId) {
    const settings = normalizeSettings(this.demo.settings);
    const service = this.requireService(settings, serviceId);
    const runtime = this.demo.services[serviceId] || {};

    runtime.generated = true;
    runtime.runtimeStatus = runtime.runtimeStatus || "not-deployed";
    runtime.reachable = runtime.reachable || false;
    runtime.updateStatus = runtime.updateStatus || "unchecked";
    this.demo.services[serviceId] = runtime;

    this.pushActivity({
      kind: "generate",
      level: "info",
      message: `Regenerated stack files for ${service.name}.`
    });

    return {
      ok: true,
      generated: [
        {
          serviceId: service.id,
          composePath: `${service.stackDir}/compose.yml`,
          envPath: `${service.stackDir}/.env`
        }
      ]
    };
  }

  async installManagedService(serviceId) {
    const settings = normalizeSettings(this.demo.settings);
    const service = this.requireService(settings, serviceId);
    const runtime = this.demo.services[serviceId] || {};

    runtime.generated = true;
    runtime.runtimeStatus = "running";
    runtime.reachable = true;
    runtime.httpStatus = 200;
    runtime.latencyMs = runtime.latencyMs || 60;
    runtime.updateStatus = runtime.updateStatus || "unchecked";
    runtime.lastError = null;
    this.demo.services[serviceId] = runtime;

    this.pushActivity({
      kind: "install",
      level: "info",
      message: `Installed ${service.name}.`
    });

    return {
      ok: true,
      stdout: `Deploy completed for ${service.name}.`,
      stderr: ""
    };
  }

  async checkServiceUpdate(serviceId) {
    const settings = normalizeSettings(this.demo.settings);
    const service = this.requireService(settings, serviceId);
    const runtime = this.demo.services[serviceId] || {};

    runtime.updateCheckedAt = nowIso();
    runtime.updateStatus = runtime.updateStatus === "ready" ? "ready" : "current";
    this.demo.services[serviceId] = runtime;

    this.pushActivity({
      kind: "update-check",
      level: "info",
      message: `Checked image update status for ${service.name}: ${runtime.updateStatus}.`
    });

    return {
      ok: true,
      updateStatus: runtime.updateStatus,
      stdout: `Update check completed for ${service.name}.`,
      stderr: ""
    };
  }

  async upgradeManagedService(serviceId) {
    const settings = normalizeSettings(this.demo.settings);
    const service = this.requireService(settings, serviceId);
    const runtime = this.demo.services[serviceId] || {};

    runtime.generated = true;
    runtime.runtimeStatus = "running";
    runtime.reachable = true;
    runtime.httpStatus = 200;
    runtime.latencyMs = runtime.latencyMs || 55;
    runtime.updateStatus = "current";
    runtime.updateCheckedAt = nowIso();
    runtime.lastError = null;
    this.demo.services[serviceId] = runtime;

    this.pushActivity({
      kind: "upgrade",
      level: "info",
      message: `Upgraded ${service.name}.`
    });

    return {
      ok: true,
      stdout: `Upgrade completed for ${service.name}.`,
      stderr: ""
    };
  }

  async checkAllUpdates() {
    const settings = normalizeSettings(this.demo.settings);
    const results = [];

    for (const serviceId of settings.selectedServiceIds) {
      const runtime = this.demo.services[serviceId] || {};
      runtime.updateCheckedAt = nowIso();
      runtime.updateStatus = runtime.updateStatus === "ready" ? "ready" : "current";
      this.demo.services[serviceId] = runtime;
      results.push({
        serviceId,
        ok: true,
        updateStatus: runtime.updateStatus
      });
    }

    this.pushActivity({
      kind: "update-check-all",
      level: "info",
      message: "Checked update status across the selected stack."
    });

    return {
      ok: true,
      results
    };
  }

  async upgradeAll() {
    return this.upgradeAllJob();
  }

  async resetDemo() {
    this.resetScenario();
    return {
      ok: true,
      state: await this.buildState()
    };
  }

  async renderDemoAppPage(serviceId) {
    const state = await this.buildState();
    const service = state.services.find((item) => item.id === serviceId);

    if (!service) {
      return null;
    }

    const statusTone = service.reachable ? "ok" : "warn";
    const updateTone = service.updateStatus === "ready" ? "warn" : "ok";

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${service.name} Demo</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #1c1914;
        --muted: #63594b;
        --bg: #f7f0e4;
        --panel: #fff9f2;
        --line: rgba(57, 47, 31, 0.14);
        --ok: #2e8b57;
        --warn: #cc7a00;
        font-family: "Avenir Next", "Segoe UI Variable", "Trebuchet MS", sans-serif;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: var(--ink);
        background: linear-gradient(140deg, var(--bg) 0%, #f4eee3 100%);
      }
      main {
        max-width: 960px;
        margin: 0 auto;
        padding: 32px 20px 56px;
      }
      .panel {
        border: 1px solid var(--line);
        border-radius: 28px;
        background: var(--panel);
        padding: 24px;
        box-shadow: 0 24px 80px rgba(59, 41, 13, 0.12);
      }
      .eyebrow {
        margin: 0 0 10px;
        color: #125b9a;
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      h1, h2 { font-family: "Iowan Old Style", "Palatino Linotype", serif; }
      h1 { margin: 0; font-size: clamp(2.2rem, 4vw, 4rem); }
      .copy { color: var(--muted); line-height: 1.6; }
      .row, .metrics { display: flex; gap: 12px; flex-wrap: wrap; }
      .metrics { margin-top: 18px; }
      .card {
        flex: 1 1 220px;
        min-width: 220px;
        border-radius: 18px;
        padding: 16px;
        background: rgba(244, 235, 223, 0.76);
      }
      .label {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 6px 12px;
        font-size: 0.78rem;
        font-weight: 700;
        background: rgba(18, 91, 154, 0.12);
      }
      .label.ok { color: #155738; background: rgba(46, 139, 87, 0.16); }
      .label.warn { color: #7e4d00; background: rgba(204, 122, 0, 0.16); }
      a {
        color: #083a67;
        font-weight: 700;
        text-decoration: none;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="panel">
        <p class="eyebrow">Demo App</p>
        <h1>${service.name}</h1>
        <p class="copy">${service.description} This is a Keelarr demo destination page so you can verify deep links without running the real upstream app.</p>
        <div class="row">
          <span class="label ${statusTone}">${service.reachable ? "Healthy" : "Needs Review"}</span>
          <span class="label ${updateTone}">${service.updateStatus === "ready" ? "Update Ready" : "Current"}</span>
          <span class="label">Port ${service.port}</span>
        </div>
        <div class="metrics">
          <div class="card">
            <strong>Runtime</strong>
            <p class="copy">${service.runtimeStatus}</p>
          </div>
          <div class="card">
            <strong>HTTP</strong>
            <p class="copy">${service.httpStatus ?? "n/a"} in ${service.latencyMs ?? "n/a"}ms</p>
          </div>
          <div class="card">
            <strong>Managed Draft</strong>
            <p class="copy">${service.generated ? "Compose and env files are ready." : "Draft files have not been generated yet."}</p>
          </div>
        </div>
        <p class="copy" style="margin-top: 24px;">
          <a href="/">Return to Keelarr dashboard</a>
        </p>
      </div>
    </main>
  </body>
</html>`;
  }

  findImportCandidate(containerId) {
    const item = this.demo.importItems.find((candidate) => candidate.containerId === containerId);
    if (!item) {
      throw new KeelarrError(`Unknown import candidate: ${containerId}`, {
        statusCode: 404
      });
    }

    return item;
  }

  pushActivity(entry) {
    this.demo.activity = [
      {
        id: crypto.randomUUID(),
        at: nowIso(),
        ...entry
      },
      ...this.demo.activity
    ].slice(0, 80);
  }

  requireService(settings, serviceId) {
    const service = settings.services[serviceId];
    if (!service) {
      throw new KeelarrError(`Unknown or disabled service: ${serviceId}`, {
        statusCode: 404
      });
    }

    return service;
  }
}
