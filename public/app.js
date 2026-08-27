/**
 * Where the heart icon and the footer link point.
 *
 * A single constant because this ships in software other people run on their
 * own hardware: anyone forking Keelarr should be able to point it at their own
 * page, or empty it, in one edit. Empty means no heart and no footer link at
 * all — a fork with nobody to pay should not be asking for money.
 *
 * A link and nothing else. Keelarr holds the Docker socket; it has no business
 * anywhere near a payment, and the service on the other end is the one equipped
 * to handle cards, receipts and tax.
 */
const SUPPORT_URL = "https://ko-fi.com/keelarr";

/**
 * The catalog order, taken from the controller rather than repeated here.
 *
 * This used to be a hardcoded list of ids, which made it a second source of
 * truth that nobody remembered to update: three services added to the server's
 * catalog were invisible in the UI, and — worse — saving settings filtered the
 * selection through this list, so anything missing from it was silently dropped
 * from the selection rather than merely hidden.
 */
function appOrder() {
  return state.catalog.map((service) => service.id);
}

const state = {
  configured: false,
  // Null until the first /api/auth/status answers. Nothing else is fetched
  // before then, because every other endpoint is behind the password.
  auth: null,
  catalog: [],
  settings: null,
  services: [],
  diagnostics: [],
  activity: [],
  hostDetection: null,
  importScan: null,
  importPreview: null,
  meta: null
};

const ui = {
  view: "stack",
  warnOpen: true,
  advOpen: false,
  jsonOpen: false,
  latestResult: null,
  toast: null,
  toastTimer: null,
  pathPicker: null,
  removal: null,
  // Read-only report on how the apps are connected to each other.
  wiring: null,
  rowMenu: null,
  busy: null,
  selectedImportContainerId: null,
  pendingServices: new Set(),
  // Confirmation dialog for a cutover or revert, mirroring the server-side
  // gate: the operator has to type the container name being replaced.
  cutover: null,
  // Latest cutover/revert job snapshot, polled while it runs.
  job: null,
  jobTimer: null,
  // Set while polling cannot reach the controller. Held separately from the
  // job so a lost connection annotates the panel rather than replacing it:
  // the job is still running on the host whether or not this page can see it.
  jobStale: null,
  jobStaleFatal: false,
  authPassword: "",
  authConfirm: "",
  authError: null,
  authBusy: false,
  // Why the very first load could not reach the controller. Distinct from a
  // toast: at this point there is no dashboard to lay a toast over, so the
  // failure has to be the page.
  bootstrapError: null,
  // Set while the release check is in flight, so the footer can say so without
  // taking over the screen the way runBusy would.
  controllerCheckBusy: false,
  // The update dialog, and the watch that outlives the backend it started.
  controllerUpdate: null,
  controllerUpdateTimer: null
};

const CONTROLLER_UPDATE_KEY = "keelarr.controllerUpdate";
// A record older than this is a laptop that was closed mid-update, not an
// update still in progress.
const CONTROLLER_UPDATE_STALE_MS = 60 * 60 * 1000;
// Shallow and bounded on purpose. A doubling backoff that reaches a minute
// means a controller back at second twelve is reported at second sixty.
const CONTROLLER_PROBE_STEPS = [[30_000, 2000], [120_000, 4000], [Infinity, 8000]];
// The old container answers normally while the new image is still being pulled,
// so a same-version answer is not proof that nothing happened until it has kept
// saying so for a while after first contact.
const SAME_VERSION_GRACE_MS = 45_000;

const appNode = document.querySelector("#app");
const directoryBrowseFields = new Set([
  "stackRoot",
  "configRoot",
  "mediaRoot",
  "downloadsRoot",
  "plexLogsRoot"
]);

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });
  const data = await response.json();

  // A session can lapse under a page that is already open. Rather than let
  // every caller surface "Sign in to continue." as a red banner over a stale
  // dashboard, put the sign-in screen back up.
  if (response.status === 401 && state.auth) {
    state.auth = {
      ...state.auth,
      configured: data.details?.configured ?? state.auth.configured,
      authenticated: false
    };
    ui.authError = null;
    render();
  }

  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || "Request failed.");
    error.details = data.details || null;
    error.payload = data;
    throw error;
  }

  return data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value) {
  if (!value) {
    return "";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return parsed.toLocaleString();
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function normalizeBrowsePath(value) {
  const trimmed = String(value || "").trim();

  if (!trimmed || trimmed === "/") {
    return "/";
  }

  return stripTrailingSlash(trimmed);
}

function appDisplayName() {
  return state.meta?.appName || "Keelarr";
}

function appVersion() {
  return state.meta?.version || "0.1.0";
}

function catalogMap() {
  return new Map(state.catalog.map((service) => [service.id, service]));
}

function selectedServiceIds() {
  return [...(state.settings?.selectedServiceIds || [])];
}

function liveServiceMap() {
  return new Map(state.services.map((service) => [service.id, service]));
}

function buildRenderService(id) {
  const catalog = catalogMap().get(id);
  if (!catalog) {
    return null;
  }

  const live = liveServiceMap().get(id) || null;
  const port = live?.port ?? catalog.defaultPort;

  return {
    id,
    name: live?.name ?? catalog.name,
    description: live?.description ?? catalog.description,
    family: live?.family ?? catalog.family,
    port,
    appUrl: live?.appUrl || null,
    generated: live?.generated === true,
    managementState: live?.managementState || "catalog",
    runtimeStatus: live?.runtimeStatus || "not-deployed",
    runtimeSource: live?.runtimeSource || "none",
    // Three states, not two: true is "something answered", false is "asked and
    // failed", null is "not checked from here". Collapsing null into false
    // paints an app the controller cannot route to as though it were down.
    reachable: live?.reachable ?? null,
    unpublishedPorts: live?.unpublishedPorts || [],
    healthStatus: live?.healthStatus || "unknown",
    httpStatus: live?.httpStatus ?? null,
    latencyMs: live?.latencyMs ?? null,
    updateStatus: live?.updateStatus || "unknown",
    updateCheckedAt: live?.updateCheckedAt || null,
    observedImage: live?.observedImage || live?.image || catalog.defaultImage,
    observedImageId: live?.observedImageId || null,
    appVersion: live?.appVersion || null,
    observedContainerId: live?.observedContainerId || null,
    observedContainerName: live?.observedContainerName || live?.containerName || id,
    observedNetworkMode: live?.observedNetworkMode || live?.networkMode || "default",
    resourceUsage: live?.resourceUsage || null,
    publishings: Array.isArray(live?.publishings) ? live.publishings : [],
    networks: Array.isArray(live?.networks) ? live.networks : [],
    cutoverAt: live?.cutoverAt || null,
    rollbackContainerName: live?.rollbackContainerName || null,
    rollbackPoint: live?.rollbackPoint || null,
    lastError: live?.lastError || null
  };
}

/** Rollback is only offered when a backup recorded a reachable prior image. */
function canRollbackImage(service) {
  return Boolean(service.rollbackPoint?.imageRef) && service.managementState === "managed";
}

/** A preserved pre-cutover container is what makes revert possible. */
function canRevertCutover(service) {
  return Boolean(service.rollbackContainerName) && service.managementState === "managed";
}

function selectedServices() {
  return selectedServiceIds()
    .map((id) => buildRenderService(id))
    .filter(Boolean);
}

function selectedCatalogEntries() {
  const selected = new Set(selectedServiceIds());
  return appOrder()
    .filter((id) => catalogMap().has(id))
    .map((id) => catalogMap().get(id))
    .filter((service) => selected.has(service.id));
}

function isServiceRunning(service) {
  return service.runtimeStatus?.toLowerCase().includes("running");
}

function imageTagFromRef(image = "") {
  const trimmed = String(image || "").trim();
  if (!trimmed) {
    return "unknown";
  }

  const withoutDigest = trimmed.split("@")[0];
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");

  if (lastColon > lastSlash) {
    return withoutDigest.slice(lastColon + 1);
  }

  return "latest";
}

function shortImageId(imageId = "") {
  const trimmed = String(imageId || "").trim();

  if (!trimmed) {
    return "";
  }

  return trimmed.replace(/^sha256:/, "").slice(0, 12);
}

function formatCompactPercent(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return null;
  }

  const absolute = Math.abs(numeric);

  if (absolute >= 10) {
    return `${Math.round(numeric)}%`;
  }

  if (absolute >= 1) {
    return `${numeric.toFixed(1).replace(/\.0$/, "")}%`;
  }

  return `${numeric.toFixed(1)}%`;
}

function formatUsageSummary(service) {
  const usage = service.resourceUsage;

  if (!usage) {
    return null;
  }

  const cpuPercent = formatCompactPercent(usage.cpuPercent);
  const memoryPercent = formatCompactPercent(usage.memoryPercent);
  const cpuDetail = usage.cpuPercentDisplay || (cpuPercent || "n/a");
  const memoryDetail = usage.memoryPercentDisplay || (memoryPercent || "n/a");
  const memoryUsageDetail = usage.memoryUsageDisplay || "n/a";

  return {
    cpuPercent,
    memoryPercent,
    cpuTitle: `CPU ${cpuDetail}`,
    memoryTitle: `Memory ${memoryDetail} (${memoryUsageDetail})`
  };
}

function renderUsageMetrics(service) {
  const usage = formatUsageSummary(service);

  if (!usage) {
    return '<span class="usage-metric-empty secondary-copy">-</span>';
  }

  return `
    <div class="usage-metrics">
      <span class="usage-metric" title="${escapeHtml(usage.cpuTitle)}" aria-label="${escapeHtml(usage.cpuTitle)}">
        <i class="fa-solid fa-microchip"></i>
        <span>${escapeHtml(usage.cpuPercent || "-")}</span>
      </span>
      <span class="usage-metric" title="${escapeHtml(usage.memoryTitle)}" aria-label="${escapeHtml(usage.memoryTitle)}">
        <i class="fa-solid fa-memory"></i>
        <span>${escapeHtml(usage.memoryPercent || "-")}</span>
      </span>
    </div>
  `;
}

function managementStateMeta(service) {
  switch (service.managementState) {
    case "managed":
      return { label: "Managed", tone: "info", detail: "Running under Keelarr Compose." };
    case "draft":
      return { label: "Draft", tone: "warn", detail: "Managed draft exists, but cutover is still pending." };
    case "detected":
      return { label: "Detected", tone: "manual", detail: "Live container found outside Keelarr management." };
    case "generated":
      return { label: "Generated", tone: "manual", detail: "Compose files exist, but the service is not running under Keelarr." };
    default:
      return { label: "Catalog", tone: "manual", detail: "Selected in catalog only." };
  }
}

/**
 * Compose ownership as one icon. The distinction that matters is whether
 * Keelarr can operate this service, not the internal state name.
 */
function composeIconMeta(service) {
  if (service.managementState === "managed") {
    return { icon: "fa-solid fa-circle-check", tone: "good", title: "Managed by Keelarr — compose files in place and owned by this stack." };
  }

  if (service.managementState === "draft") {
    return { icon: "fa-solid fa-file-pen", tone: "warn", title: "Draft generated from a live container. Review it, then cut over." };
  }

  if (service.managementState === "detected") {
    return { icon: "fa-solid fa-eye", tone: "warn", title: "Running outside Keelarr. Generate a draft to adopt it." };
  }

  if (service.managementState === "generated") {
    return { icon: "fa-solid fa-file-code", tone: "idle", title: "Compose files written, but nothing is running yet." };
  }

  return { icon: "fa-regular fa-circle", tone: "idle", title: "Not installed. In the catalog only." };
}

/** Container state as one icon. */
function runtimeIconMeta(service) {
  if (isServiceRunning(service)) {
    return { icon: "fa-solid fa-play", tone: "good", title: "Container is running." };
  }

  if (service.runtimeStatus === "restarting") {
    return { icon: "fa-solid fa-rotate", tone: "warn", title: "Container is restarting." };
  }

  if (service.runtimeStatus === "exited" || service.runtimeStatus === "dead") {
    return { icon: "fa-solid fa-circle-stop", tone: "danger", title: `Container is ${service.runtimeStatus}.` };
  }

  return { icon: "fa-regular fa-circle", tone: "idle", title: "Not deployed." };
}

/**
 * Health collapsed to three answers, because "reachable" vs "running" vs
 * "healthy" described how we learned it rather than what the user needs to
 * know. The tooltip carries the detail.
 */
function healthIconMeta(service) {
  const detail = [
    service.httpStatus ? `HTTP ${service.httpStatus}` : null,
    service.latencyMs ? `${service.latencyMs} ms` : null
  ].filter(Boolean).join(" · ");

  if (service.healthStatus === "unhealthy" || service.runtimeStatus === "exited" || service.runtimeStatus === "dead") {
    return { icon: "fa-solid fa-heart-crack", tone: "danger", title: "Not healthy. The container reports a failing healthcheck or has stopped." };
  }

  if (service.healthStatus === "starting") {
    return { icon: "fa-solid fa-hourglass-half", tone: "warn", title: "Still starting up." };
  }

  if (service.healthStatus === "healthy") {
    return { icon: "fa-solid fa-heart", tone: "good", title: "Healthy — the container's own healthcheck passes." };
  }

  if (service.reachable) {
    return {
      icon: "fa-solid fa-heart",
      tone: "good",
      title: `Responding${detail ? ` (${detail})` : ""}. This image has no built-in healthcheck, so Keelarr checked the app URL.`
    };
  }

  if (!isServiceRunning(service)) {
    return { icon: "fa-regular fa-circle", tone: "idle", title: "Not running." };
  }

  // A declared port that Docker never bound is the specific, fixable reason —
  // worth saying instead of the general one, because the app is fine and the
  // address is not.
  if (service.unpublishedPorts?.length) {
    return {
      icon: "fa-solid fa-plug-circle-exclamation",
      tone: "warn",
      title: `Running, but ${service.unpublishedPorts.join(", ")} was never published to the host — usually because that port was already taken. `
        + `The app cannot be opened at the address shown, and that address may belong to whatever else claimed the port.`
    };
  }

  return {
    icon: "fa-solid fa-circle-question",
    tone: "idle",
    title: "Running, but health could not be confirmed. No healthcheck, and the app URL is not reachable from the controller."
  };
}

function runtimeStatusMeta(service) {
  if (isServiceRunning(service)) {
    return {
      label: service.runtimeSource === "compose" ? "Running" : "Live",
      tone: "info"
    };
  }

  if (service.runtimeStatus === "exited" || service.runtimeStatus === "dead") {
    return { label: service.runtimeStatus, tone: "error" };
  }

  if (service.runtimeStatus === "created" || service.runtimeStatus === "restarting") {
    return { label: service.runtimeStatus, tone: "warn" };
  }

  return { label: "Not Deployed", tone: "manual" };
}

function healthStatusMeta(service) {
  switch (service.healthStatus) {
    case "healthy":
      return { label: "Healthy", tone: "info" };
    case "unhealthy":
      return { label: "Unhealthy", tone: "error" };
    case "starting":
      return { label: "Starting", tone: "warn" };
    case "reachable":
      return { label: "Reachable", tone: "info" };
    case "running":
      return { label: "Running", tone: "info" };
    case "exited":
    case "dead":
      return { label: service.healthStatus, tone: "error" };
    default:
      return { label: "Unknown", tone: "manual" };
  }
}

function updateStatusMeta(service) {
  switch (service.updateStatus) {
    case "ready":
      return { label: "Update Ready", tone: "warn" };
    case "current":
      return { label: "Current", tone: "info" };
    case "cutover-pending":
      return { label: "Cutover Pending", tone: "warn" };
    case "unmanaged":
      return { label: "Not Managed", tone: "manual" };
    case "not-deployed":
      return { label: "Not Deployed", tone: "manual" };
    case "unchecked":
      return { label: "Unchecked", tone: "manual" };
    default:
      return { label: "Unknown", tone: "manual" };
  }
}

function resolveUiHostBase() {
  const configuredHostUrl = stripTrailingSlash(state.settings?.hostUrl || "http://localhost");

  try {
    const configured = new URL(configuredHostUrl);
    if (!["localhost", "127.0.0.1", "::1"].includes(configured.hostname)) {
      return configured;
    }
  } catch {
    // Fall back to the current browser location.
  }

  const current = new URL(window.location.href);
  return new URL(`${current.protocol}//${current.hostname}`);
}

/**
 * The server resolves this now, from the browser's network position rather than
 * the controller's. What used to be here guessed at macvlan by matching the
 * `qnet-static` name prefix, which worked on one vendor's NAS by coincidence.
 */
function resolveServiceOpenUrl(service) {
  return service.appUrl;
}

function hasTautulliWarning() {
  return selectedServiceIds().includes("tautulli") && !String(state.settings?.plexLogsRoot || "").trim();
}

function visibleWarningCount() {
  return hasTautulliWarning() && ui.warnOpen ? 1 : 0;
}

function defaultActivityRows() {
  return state.activity.map((item) => ({
    text: item.message || item.kind || "Activity event",
    tag: activityCommandTag(item),
    when: formatDate(item.at),
    ok: item.level !== "error"
  }));
}

function activityCommandTag(item) {
  const map = {
    setup: "config-save",
    generate: "config-save",
    deploy: "deploy-all",
    install: "deploy-service",
    "update-check-all": "update-check-all",
    "update-check": "update-check",
    upgrade: "upgrade-service",
    "import-draft": "import-draft",
    "docker-scan": "docker-scan",
    "host-detect": "host-detect"
  };

  return map[item.kind] || String(item.kind || "activity").replace(/\s+/g, "-").toLowerCase();
}

function buildLatestResultPayload() {
  if (ui.latestResult?.data) {
    return ui.latestResult.data;
  }

  return {
    ok: true,
    results: selectedServices().map((service) => ({
      serviceId: service.id,
      ok: isServiceRunning(service),
      updateStatus: "unknown"
    }))
  };
}

const inspectionFieldLabels = {
  dockerBin: "Docker Binary",
  stackRoot: "Compose Stack Root",
  configRoot: "Config Root",
  mediaRoot: "Media Root",
  downloadsRoot: "Downloads Root",
  plexLogsRoot: "Plex Logs Path"
};

function latestResultData() {
  return ui.latestResult?.data || null;
}

function currentHostInspection() {
  const latest = latestResultData();
  if (latest?.selected && Array.isArray(latest?.detections)) {
    return latest;
  }

  if (latest?.hostDetection?.selected && Array.isArray(latest?.hostDetection?.detections)) {
    return latest.hostDetection;
  }

  if (latest?.details?.selected && Array.isArray(latest?.details?.detections)) {
    return latest.details;
  }

  return state.hostDetection;
}

function currentHostValidation() {
  const latest = latestResultData();
  if (latest?.validation?.fieldResults) {
    return latest.validation;
  }

  if (latest?.details?.fieldResults) {
    return latest.details;
  }

  if (state.hostDetection?.validation?.fieldResults) {
    return state.hostDetection.validation;
  }

  return null;
}

function currentEffectiveSettings() {
  const latest = latestResultData();
  if (latest?.effectiveSettings) {
    return latest.effectiveSettings;
  }

  if (latest?.details?.effectiveSettings) {
    return latest.details.effectiveSettings;
  }

  if (state.hostDetection?.effectiveSettings) {
    return state.hostDetection.effectiveSettings;
  }

  return state.settings;
}

function currentGeneratedArtifacts() {
  const latest = latestResultData();
  if (!latest) {
    return null;
  }

  if (latest.generated && !Array.isArray(latest.generated)) {
    return latest.generated;
  }

  if (Array.isArray(latest.generated) && latest.generated.length === 1) {
    return latest.generated[0];
  }

  return null;
}

const TOAST_VISIBLE_MS = 6000;

/**
 * Wraps a long action so the UI shows it is working. Deploying a stack takes
 * many seconds against a NAS, and without this the click looks like it did
 * nothing at all.
 */
async function runBusy(label, run) {
  ui.busy = { label };
  render();

  try {
    return await run();
  } finally {
    ui.busy = null;
    render();
  }
}

function renderBusyBanner() {
  if (!ui.busy) {
    return "";
  }

  return `
    <div class="busy-shell">
      <div class="busy-panel">
        <i class="fa-solid fa-spinner fa-spin"></i>
        <span>${escapeHtml(ui.busy.label)}</span>
      </div>
    </div>
  `;
}

function showToast(message, tone = "info") {
  ui.toast = {
    message,
    tone
  };

  if (ui.toastTimer) {
    window.clearTimeout(ui.toastTimer);
  }

  // Paint immediately. Callers routinely continue into a slow refresh, and on
  // a slow host the dismiss timer would otherwise clear the toast before any
  // render ever showed it — which is exactly how "save" appeared to do nothing.
  render();

  ui.toastTimer = window.setTimeout(() => {
    ui.toast = null;
    ui.toastTimer = null;
    render();
  }, TOAST_VISIBLE_MS);
}

function closeToast() {
  if (ui.toastTimer) {
    window.clearTimeout(ui.toastTimer);
    ui.toastTimer = null;
  }

  ui.toast = null;
}

function resultToneClass(level = "info") {
  if (level === "error") {
    return "status-pill-danger";
  }

  if (level === "warn") {
    return "status-pill-warning";
  }

  if (level === "manual") {
    return "status-pill-idle";
  }

  return "status-pill-info";
}

function renderStatusPill(label, level = "info") {
  return `<span class="status-pill ${resultToneClass(level)}">${escapeHtml(label)}</span>`;
}

function resultSummaryText() {
  const latest = latestResultData();
  if (!ui.latestResult || !latest) {
    return "";
  }

  if (latest.ok === false) {
    return latest.error || "The last operation failed.";
  }

  if (ui.latestResult.title === "Host Detection") {
    const inspection = currentHostInspection();
    const validation = currentHostValidation();
    const selectedLabel = inspection?.selected?.label || "host profile";

    if (validation?.ok === false) {
      return `Detected ${selectedLabel}, but validation found ${validation.errors.length} blocker(s).`;
    }

    return `Detected ${selectedLabel} and validated the current draft settings.`;
  }

  if (ui.latestResult.title === "Settings Saved") {
    return "Saved host settings without generating or deploying any stacks.";
  }

  if (Array.isArray(latest.generated) && latest.generated.length > 0) {
    return `Generated ${latest.generated.length} stack folder(s).`;
  }

  if (Array.isArray(latest.results)) {
    const okCount = latest.results.filter((item) => item.ok).length;
    return `${okCount} of ${latest.results.length} operations succeeded.`;
  }

  if (latest.ok === true) {
    return "The last operation completed successfully.";
  }

  return "";
}

function renderResultPanel() {
  const latest = latestResultData();
  if (!ui.latestResult || !latest || ui.view === "activity" || ui.latestResult.title === "Import Preview") {
    return "";
  }

  const validation = currentHostValidation();
  const generated = currentGeneratedArtifacts();
  const errors = validation?.errors || [];
  const warnings = validation?.warnings || [];
  const summary = resultSummaryText();
  const failed = latest.ok === false;

  // A bare "completed successfully" on every screen is noise: the toast already
  // confirmed it and the job panel shows the detail. Only stay on screen when
  // carrying something the user cannot get elsewhere.
  if (!failed && !errors.length && !warnings.length && !generated) {
    return "";
  }

  return `
    <div class="result-panel ${failed ? "result-panel-danger" : "result-panel-info"}">
      <div class="result-panel-header">
        <div>
          <div class="result-panel-title">${escapeHtml(ui.latestResult.title)}</div>
          ${summary ? `<div class="result-panel-copy">${escapeHtml(summary)}</div>` : ""}
        </div>
        <div class="result-panel-actions">
          ${renderStatusPill(failed ? "Needs Attention" : "Details", failed ? "error" : "info")}
          <button type="button" class="toast-dismiss" data-result-dismiss="true" aria-label="Dismiss">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
      </div>
      ${errors.length
        ? `
          <div class="result-list result-list-danger">
            <strong>Blockers</strong>
            <ul>${errors.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
          </div>
        `
        : ""}
      ${warnings.length
        ? `
          <div class="result-list result-list-warning">
            <strong>Warnings</strong>
            <ul>${warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
          </div>
        `
        : ""}
      ${generated
        ? `
          <div class="result-list">
            <strong>Generated Files</strong>
            <ul>
              ${generated.composePath ? `<li>${escapeHtml(generated.composePath)}</li>` : ""}
              ${generated.envPath ? `<li>${escapeHtml(generated.envPath)}</li>` : ""}
              ${generated.envExamplePath ? `<li>${escapeHtml(generated.envExamplePath)}</li>` : ""}
              ${generated.reviewSummaryPath ? `<li>${escapeHtml(generated.reviewSummaryPath)}</li>` : ""}
              ${generated.reviewNotesPath ? `<li>${escapeHtml(generated.reviewNotesPath)}</li>` : ""}
            </ul>
          </div>
        `
        : ""}
    </div>
  `;
}

function renderToast() {
  if (!ui.toast?.message) {
    return "";
  }

  const tone = ui.toast.tone;
  const toneClass = tone === "error" || tone === "danger"
    ? "toast-panel-danger"
    : tone === "success"
      ? "toast-panel-success"
      : "toast-panel-info";
  const toneIcon = tone === "error" || tone === "danger"
    ? "fa-solid fa-circle-exclamation"
    : tone === "success"
      ? "fa-solid fa-circle-check"
      : "fa-solid fa-circle-info";

  return `
    <div class="toast-shell">
      <div class="toast-panel ${toneClass}">
        <i class="${toneIcon} toast-icon"></i>
        <span>${escapeHtml(ui.toast.message)}</span>
        <button type="button" class="toast-dismiss" data-toast-dismiss="true" aria-label="Dismiss notification">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    </div>
  `;
}

function renderSidebarNav() {
  const navItems = [
    {
      id: "stack",
      label: "Stack",
      icon: "fa-solid fa-layer-group",
      badge: String(selectedServiceIds().length)
    },
    {
      id: "adoption",
      label: "Adoption",
      icon: "fa-brands fa-docker",
      badge: ""
    },
    {
      id: "activity",
      label: "Activity",
      icon: "fa-solid fa-clock-rotate-left",
      badge: ""
    },
    {
      id: "settings",
      label: "Settings",
      icon: "fa-solid fa-gears",
      badge: ""
    }
  ];

  return navItems
    .map((item) => {
      const active = ui.view === item.id;
      return `
        <div class="sidebar-item ${active ? "sidebar-item-active" : ""}">
          <button type="button" class="sidebar-link ${active ? "sidebar-link-active" : ""}" data-nav-view="${escapeHtml(item.id)}">
            <span class="sidebar-link-label">
              <span class="sidebar-link-icon"><i class="${escapeHtml(item.icon)}"></i></span>
              ${escapeHtml(item.label)}
            </span>
            <span class="sidebar-link-badge">${escapeHtml(item.badge)}</span>
          </button>
        </div>
      `;
    })
    .join("");
}

function renderHostSummary() {
  const inspection = currentHostInspection();
  const validation = currentHostValidation();
  const hostName = inspection?.selected?.label || state.settings?.hostLabel || "Docker Host";
  const composeState = validation?.fieldResults?.dockerBin?.ok ? "compose ok" : "compose pending";
  const stackRootState = selectedServices().some((service) => service.generated) ? "stack root ready" : "stack root pending";

  return `
    <div class="host-summary">
      <div class="host-summary-title">Host</div>
      <div class="host-summary-body">
        ${escapeHtml(hostName)}<br>
        ${escapeHtml(composeState)} &middot; ${escapeHtml(stackRootState)}<br>
        tz ${escapeHtml(state.settings?.tz || "America/Chicago")}
      </div>
    </div>
  `;
}

function toolbarButtons() {
  if (ui.view === "stack") {
    const services = selectedServices();
    // Only offer Deploy All when something is actually undeployed. On a fully
    // running stack it reads as a mystery button that recreates containers for
    // no reason.
    const undeployed = services.filter((service) => service.managementState === "catalog" || !service.generated).length;
    const updatesReady = services.filter((service) => service.updateStatus === "ready").length;

    return [
      { action: "refresh", icon: "fa-solid fa-rotate", label: "Refresh" },
      ...(undeployed
        ? [{ action: "deploy-all", icon: "fa-solid fa-cloud-arrow-up", label: `Deploy ${undeployed}` }]
        : []),
      { action: "check-updates", icon: "fa-solid fa-magnifying-glass-chart", label: "Check Updates" },
      { action: "check-wiring", icon: "fa-solid fa-diagram-project", label: "Check Wiring" },
      ...(updatesReady
        ? [{ action: "upgrade-all", icon: "fa-solid fa-arrow-up-right-dots", label: `Upgrade ${updatesReady}` }]
        : [])
    ];
  }

  if (ui.view === "adoption") {
    return [
      { action: "scan-docker", icon: "fa-brands fa-docker", label: "Scan Docker" },
      { action: "preview-draft", icon: "fa-solid fa-file-code", label: "Preview Draft" }
    ];
  }

  if (ui.view === "activity") {
    return [
      { action: "refresh", icon: "fa-solid fa-rotate", label: "Refresh" },
      { action: "clear-activity", icon: "fa-solid fa-eraser", label: "Clear" }
    ];
  }

  return [
    { action: "save", icon: "fa-solid fa-floppy-disk", label: "Save" },
    { action: "detect-host", icon: "fa-solid fa-wand-magic-sparkles", label: "Detect Host" },
    { action: "toggle-advanced", icon: "fa-solid fa-user-gear", label: ui.advOpen ? "Hide Advanced" : "Show Advanced" }
  ];
}

function renderToolbar() {
  const buttons = toolbarButtons()
    .map((button) => `
      <button type="button" class="toolbar-button" data-toolbar-action="${escapeHtml(button.action)}">
        <span class="toolbar-button-icon"><i class="${escapeHtml(button.icon)}"></i></span>
        <span class="toolbar-button-label">${escapeHtml(button.label)}</span>
      </button>
    `)
    .join("");

  const right = ui.view === "stack"
    ? ""
    : '<div class="toolbar-spacer"></div>';

  return `
    <div class="toolbar">
      <div class="toolbar-left">${buttons}</div>
      <div class="toolbar-right">${right}</div>
    </div>
  `;
}

function renderWarningBanner() {
  if (ui.view === "settings" || visibleWarningCount() === 0) {
    return "";
  }

  return `
    <div class="warning-banner">
      <i class="fa-solid fa-triangle-exclamation"></i>
      <span class="warning-banner-text">Tautulli is enabled but Plex logs path is empty.</span>
      <button type="button" class="warning-banner-link" data-banner-action="open-settings">Open settings</button>
      <button type="button" class="warning-banner-dismiss" data-banner-action="dismiss-warning" aria-label="Dismiss warning">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>
  `;
}

function renderRowMenu(service) {
  if (ui.rowMenu !== service.id) {
    return "";
  }

  const item = (action, icon, label, enabled = true, title = "") => `
    <button type="button" class="row-menu-item${enabled ? "" : " row-menu-item-disabled"}"
      ${enabled ? `data-row-menu-action="${escapeHtml(action)}" data-service-id="${escapeHtml(service.id)}"` : "disabled"}
      ${title ? `title="${escapeHtml(title)}"` : ""}>
      <i class="${escapeHtml(icon)}"></i><span>${escapeHtml(label)}</span>
    </button>
  `;

  const running = isServiceRunning(service);
  const installed = service.managementState !== "catalog";

  return `
    <div class="row-menu">
      ${item("install", "fa-solid fa-download", "Install", !installed,
        installed ? "Already installed." : "Deploys just this app, without touching the rest of the stack.")}
      ${item("upgrade", "fa-solid fa-circle-up", "Upgrade", installed && service.updateStatus !== "current",
        service.updateStatus === "ready"
          ? "An update is available."
          : service.updateStatus === "current"
            ? "Already on the latest image."
            : "Pulls the latest image.")}
      ${item("rollback", "fa-solid fa-clock-rotate-left", "Downgrade", canRollbackImage(service),
        canRollbackImage(service) ? `Roll back to ${service.rollbackPoint?.taggedImage || "the previous image"}.` : "No previous image recorded yet.")}
      ${item("restart", "fa-solid fa-arrows-rotate", "Restart", running, running ? "" : "Not running.")}
      <div class="row-menu-divider"></div>
      ${item("remove", "fa-solid fa-trash-can", "Remove", installed, installed ? "" : "Nothing installed to remove.")}
    </div>
  `;
}

function renderStackView() {
  const services = selectedServices();

  if (!services.length) {
    return '<div class="empty-copy">No services are selected yet. Open Settings to choose the apps Keelarr should manage.</div>';
  }

  const rows = services
    .map((service) => {
      const pending = ui.pendingServices.has(service.id);
      const compose = composeIconMeta(service);
      const runtime = runtimeIconMeta(service);
      const health = healthIconMeta(service);
      const openUrl = resolveServiceOpenUrl(service);

      // Version currency, since that is the thing worth colouring.
      const current = service.updateStatus === "current";
      const outOfDate = service.updateStatus === "ready";
      const versionClass = current ? "version-current" : outOfDate ? "version-stale" : "version-unknown";
      const versionTitle = current
        ? "Up to date."
        : outOfDate
          ? "An update is available. Use the row menu to upgrade."
          : "Update status unknown. Run Check Updates.";
      const version = service.appVersion
        ? `v${String(service.appVersion).replace(/^v/, "")}`
        : imageTagFromRef(service.observedImage);

      const icon = (meta) => `<i class="${escapeHtml(meta.icon)} chip-icon chip-icon-${escapeHtml(meta.tone)}" title="${escapeHtml(meta.title)}"></i>`;

      return `
        <tr>
          <td class="status-cell">${pending ? '<i class="fa-solid fa-spinner fa-spin secondary-copy"></i>' : icon(runtime)}</td>
          <td class="cell-truncate">
            <a href="${escapeHtml(openUrl)}" target="_blank" rel="noreferrer noopener" title="Open ${escapeHtml(service.name)}">${escapeHtml(service.name)}</a>
            <div class="secondary-copy">${escapeHtml(service.observedContainerName)}</div>
          </td>
          <td class="cell-truncate">
            <div>${escapeHtml(service.observedImage)}</div>
            <div class="secondary-copy ${versionClass}" title="${escapeHtml(versionTitle)}">${escapeHtml(version)}</div>
          </td>
          <td>${escapeHtml(String(service.port))}</td>
          <td class="chip-cell col-center">${icon(compose)}</td>
          <td>${renderUsageMetrics(service)}</td>
          <td class="chip-cell col-center">${icon(health)}</td>
          <td class="row-actions">
            <div class="row-menu-wrap">
              <button type="button" class="row-icon-button" data-row-menu="${escapeHtml(service.id)}"
                title="Actions" aria-label="Actions for ${escapeHtml(service.name)}" ${pending ? "disabled" : ""}>
                <i class="fa-solid fa-ellipsis-vertical"></i>
              </button>
              ${renderRowMenu(service)}
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  const runningCount = services.filter((service) => isServiceRunning(service)).length;
  const updateReadyCount = services.filter((service) => service.updateStatus === "ready").length;
  const summary = runningCount === 0
    ? `${escapeHtml(String(services.length))} apps selected, none currently running under Keelarr monitoring.`
    : `${escapeHtml(String(runningCount))} of ${escapeHtml(String(services.length))} live ${updateReadyCount > 0 ? `· ${escapeHtml(String(updateReadyCount))} update${updateReadyCount === 1 ? "" : "s"} ready` : "· no managed updates pending"}`;

  return `
    <div data-screen-label="Stack">
      <table class="table-view">
        <thead>
          <tr>
            <th style="width:4%;"></th>
            <th style="width:17%;">App</th>
            <th style="width:31%;">Image / Version</th>
            <th style="width:7%;">Port</th>
            <th class="col-center" style="width:10%;">Compose</th>
            <th style="width:17%;">Usage</th>
            <th class="col-center" style="width:10%;">Health</th>
            <th style="width:4%;"></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="summary-line">${summary}</div>
    </div>
  `;
}

function renderImportTable() {
  if (!state.importScan) {
    return `
      <div class="info-alert">
        <i class="fa-solid fa-circle-info"></i>
        <span>No scan run yet. Use "Scan Existing Docker" for a read-only inventory of current containers.</span>
      </div>
      <div class="muted-paragraph">Keelarr never writes during a scan. Recognized containers appear here with the managed Compose draft it would generate, so you can compare before any cutover.</div>
    `;
  }

  if (!state.importScan.items.length) {
    return `
      <div class="info-alert">
        <i class="fa-solid fa-circle-info"></i>
        <span>Read-only scan found no unmanaged containers.</span>
      </div>
      <div class="muted-paragraph">Keelarr never writes during a scan. Recognized containers appear here with the managed Compose draft it would generate, so you can compare before any cutover.</div>
    `;
  }

  const rows = state.importScan.items
    .map((item) => {
      const selected = ui.selectedImportContainerId === item.containerId;
      const portText = item.ports.length ? item.ports.map((port) => port.display).join(", ") : "-";
      const recognizedAs = item.serviceName || "Unsupported";

      return `
        <tr class="${selected ? "table-row-selected" : ""}" data-import-row="${escapeHtml(item.containerId)}">
          <td class="cell-truncate">${escapeHtml(item.containerName)}</td>
          <td class="cell-truncate secondary-copy">${escapeHtml(item.image)}</td>
          <td class="cell-truncate secondary-copy">${escapeHtml(portText)}</td>
          <td class="cell-truncate secondary-copy">${escapeHtml(recognizedAs)}</td>
          <td class="row-actions">
            ${item.recognized
              ? `
                <button
                  type="button"
                  class="row-icon-button"
                  data-import-action="preview"
                  data-container-id="${escapeHtml(item.containerId)}"
                  style="color:var(--primary-color);"
                  title="Preview draft"
                >
                  <i class="fa-solid fa-file-code"></i>
                </button>
              `
              : '<span class="secondary-copy">-</span>'}
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <table class="table-view table-clickable">
      <thead>
        <tr>
          <th style="width:18%;">Container</th>
          <th style="width:34%;">Image</th>
          <th style="width:18%;">Ports</th>
          <th style="width:20%;">Recognized As</th>
          <th style="width:10%;"></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderImportPreview() {
  if (!state.importPreview) {
    return '<div class="muted-paragraph">Select a recognized container from the adoption scan to preview its managed draft.</div>';
  }

  if (!state.importPreview.supported) {
    const warnings = (state.importPreview.warnings || [])
      .map((warning) => `<div class="preview-warning"><strong>${escapeHtml(warning.level)}:</strong> ${escapeHtml(warning.message)}</div>`)
      .join("");

    return `
      <div class="preview-card">
        <h3 class="preview-title">${escapeHtml(state.importPreview.source.containerName)}</h3>
        <div class="preview-copy">${escapeHtml(state.importPreview.source.image)}</div>
        <div style="margin-top:14px;">${warnings || '<div class="preview-copy">This container is outside the current Keelarr scope.</div>'}</div>
      </div>
    `;
  }

  const preview = state.importPreview;
  const generated = currentGeneratedArtifacts();
  const generatedPaths = generated?.serviceId === preview.target.serviceId
    ? generated
    : {
        composePath: preview.draftArtifacts?.composePath || preview.target.composePath,
        envPath: preview.draftArtifacts?.envPath || preview.target.envPath,
        envExamplePath: preview.draftArtifacts?.envExamplePath || preview.target.envExamplePath,
        reviewSummaryPath: preview.draftArtifacts?.reviewSummaryPath || null,
        reviewNotesPath: preview.draftArtifacts?.reviewNotesPath || null
      };
  const yaml = preview.draft?.composeYaml || "";
  const warnings = preview.warnings?.length
    ? preview.warnings
      .map((warning) => `<div class="preview-warning"><strong>${escapeHtml(warning.level)}:</strong> ${escapeHtml(warning.message)}</div>`)
      .join("")
    : '<div class="preview-copy">No adoption warnings.</div>';
  const summary = [
    `Image: ${preview.target.image}`,
    `Container: ${preview.target.containerName}`,
    `Restart: ${preview.target.restartPolicy || "unless-stopped"}`,
    `Network: ${preview.target.networkMode || "default"}`,
    `Env Keys: ${preview.draft?.envKeys?.length || 0}`
  ].join(" \u00b7 ");

  // Cutover only becomes available once a reviewed draft exists for this
  // service, which the dashboard reports as the `draft` management state.
  const liveService = selectedServices().find((service) => service.id === preview.target.serviceId);
  const readyForCutover = preview.adoptable && liveService?.managementState === "draft";

  return `
    <div class="preview-card">
      <div class="preview-toolbar">
        <h3 class="preview-title">${escapeHtml(preview.source.containerName)} -> ${escapeHtml(preview.target.serviceName)}</h3>
        <div class="preview-toolbar-actions">
          ${preview.adoptable
            ? `
              <button
                type="button"
                class="button-default"
                data-preview-action="adopt-draft"
                data-container-id="${escapeHtml(preview.source.containerId)}"
              >
                ${readyForCutover ? "Regenerate Draft" : "Generate Managed Draft"}
              </button>
            `
            : ""}
          ${readyForCutover
            ? `
              <button
                type="button"
                class="button-success"
                data-preview-action="cutover"
                data-container-id="${escapeHtml(preview.source.containerId)}"
              >
                Cut Over To Compose
              </button>
            `
            : ""}
        </div>
      </div>
      ${readyForCutover
        ? '<div class="muted-paragraph" style="margin-bottom:12px;">A reviewed draft exists. Cutover stops this container, keeps it as a rollback, and starts the Compose stack in its place.</div>'
        : ""}
      <div class="preview-copy" style="margin-bottom:12px;">${escapeHtml(summary)}</div>
      <pre class="json-panel preview-code">${escapeHtml(yaml)}</pre>
      ${generatedPaths
        ? `
          <div class="preview-meta" style="margin-top:16px;">
            <div class="preview-meta-item">
              <strong>Compose</strong>
              <span>${escapeHtml(generatedPaths.composePath || "-")}</span>
            </div>
            <div class="preview-meta-item">
              <strong>Env</strong>
              <span>${escapeHtml(generatedPaths.envPath || "-")}</span>
            </div>
            <div class="preview-meta-item">
              <strong>Env Example</strong>
              <span>${escapeHtml(generatedPaths.envExamplePath || "-")}</span>
            </div>
            <div class="preview-meta-item">
              <strong>Summary</strong>
              <span>${escapeHtml(generatedPaths.reviewSummaryPath || "-")}</span>
            </div>
            <div class="preview-meta-item">
              <strong>Review Notes</strong>
              <span>${escapeHtml(generatedPaths.reviewNotesPath || "-")}</span>
            </div>
          </div>
        `
        : ""}
      <div style="margin-top:16px;">
        <span class="preview-section-title">Warnings</span>
        ${warnings}
      </div>
    </div>
  `;
}

function renderAdoptionView() {
  return `
    <div data-screen-label="Adoption">
      <fieldset class="fieldset">
        <legend class="legend">Existing Docker</legend>
        ${renderImportTable()}
      </fieldset>
      <fieldset class="fieldset">
        <legend class="legend legend-secondary">Preview Managed Draft</legend>
        ${renderImportPreview()}
      </fieldset>
    </div>
  `;
}

function renderActivityView() {
  const rows = defaultActivityRows()
    .map((item) => `
      <tr>
        <td class="activity-status-cell"><i class="fa-solid ${item.ok ? "fa-circle-check activity-status-icon" : "fa-circle-exclamation status-icon-bad"}"></i></td>
        <td>${escapeHtml(item.text)}</td>
        <td class="activity-command">${escapeHtml(item.tag)}</td>
        <td class="secondary-copy">${escapeHtml(item.when)}</td>
      </tr>
    `)
    .join("");

  const json = JSON.stringify(buildLatestResultPayload(), null, 2);

  return `
    <div data-screen-label="Activity">
      <table class="table-view">
        <thead>
          <tr>
            <th style="width:34px;"></th>
            <th>Event</th>
            <th style="width:190px;">Command</th>
            <th style="width:180px;">Time</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <button type="button" class="button-default json-toggle" data-json-toggle="true">
        ${escapeHtml(ui.jsonOpen ? "Hide latest result" : "Show latest result")}
      </button>
      ${ui.jsonOpen ? `<pre class="json-panel">${escapeHtml(json)}</pre>` : ""}
    </div>
  `;
}

function renderSelectRow(field) {
  const value = String(state.settings?.[field.key] ?? "");

  return `
    <div class="form-row">
      <label class="form-label" for="${escapeHtml(field.key)}">${escapeHtml(field.label)}</label>
      <div class="form-input-wrap">
        <select id="${escapeHtml(field.key)}" class="text-input" name="${escapeHtml(field.key)}">
          ${field.options.map((option) => `
            <option value="${escapeHtml(option.value)}" ${String(option.value) === value ? "selected" : ""}>
              ${escapeHtml(option.label)}
            </option>
          `).join("")}
        </select>
        <div class="help-text">${escapeHtml(field.help)}</div>
      </div>
    </div>
  `;
}

function renderInputRow(field) {
  if (field.options) {
    return renderSelectRow(field);
  }

  const value = state.settings?.[field.key] ?? "";
  const warning = field.key === "plexLogsRoot" && hasTautulliWarning();
  const labelClass = warning ? "form-label form-label-warning" : field.advanced ? "form-label form-label-advanced" : "form-label";
  const inputClass = warning ? "text-input text-input-warning" : "text-input";
  const helpClass = warning ? "help-text help-text-warning" : "help-text";
  const browseButton = field.browse === "directory"
    ? `
      <button
        type="button"
        class="field-action-button"
        data-browse-field="${escapeHtml(field.key)}"
        aria-label="Browse directories for ${escapeHtml(field.label)}"
        title="Browse directories"
      >
        <i class="fa-regular fa-folder-open"></i>
      </button>
    `
    : "";

  return `
    <div class="form-row">
      <label class="${labelClass}" for="${escapeHtml(field.key)}">${escapeHtml(field.label)}</label>
      <div class="form-input-wrap">
        <div class="text-input-shell">
          <input
            id="${escapeHtml(field.key)}"
            class="${inputClass}"
            type="text"
            name="${escapeHtml(field.key)}"
            value="${escapeHtml(value)}"
            placeholder="${escapeHtml(field.placeholder || "")}"
            autocomplete="off"
          >
          ${browseButton}
        </div>
        <div class="${helpClass}">${escapeHtml(field.help)}</div>
      </div>
    </div>
  `;
}

function renderManageRow(service) {
  const checked = selectedServiceIds().includes(service.id);
  const deprecated = service.deprecated || null;

  return `
    <button type="button" class="manage-row" data-manage-toggle="${escapeHtml(service.id)}">
      <span class="manage-row-label">
        ${escapeHtml(service.name)}
        ${deprecated ? '<span class="manage-row-tag">unavailable</span>' : ""}
      </span>
      <span class="manage-row-body">
        <span class="manage-box ${checked ? "manage-box-checked" : ""}">${checked ? "&#10003;" : ""}</span>
        <span class="manage-description${deprecated ? " manage-description-deprecated" : ""}">
          ${escapeHtml(deprecated ? deprecated.reason : service.description)}
        </span>
      </span>
    </button>
  `;
}

function renderFirstRunGuide() {
  if (state.configured) {
    return "";
  }

  return `
    <fieldset class="fieldset">
      <legend class="legend">First Live Test</legend>
      <div class="info-alert">
        <i class="fa-solid fa-circle-info"></i>
        <span>Detect the host first, save without deploy, then use Adoption to run a read-only scan and generate one managed draft at a time.</span>
      </div>
      <div class="muted-paragraph">For an existing QNAP stack, the safest first target is Trailarr because it uses straightforward bind mounts and an explicit port mapping.</div>
    </fieldset>
  `;
}

function renderHostInspection() {
  const inspection = currentHostInspection();
  const validation = currentHostValidation();
  const effectiveSettings = currentEffectiveSettings();

  if (!inspection?.selected) {
    return `
      <fieldset class="fieldset">
        <legend class="legend">Host Detection</legend>
        <div class="info-alert">
          <i class="fa-solid fa-circle-info"></i>
          <span>Run Detect Host to validate the current Docker binary and path layout before saving.</span>
        </div>
      </fieldset>
    `;
  }

  const selected = inspection.selected;
  const fieldSuggestions = selected.fieldSuggestions || {};
  const fieldResults = validation?.fieldResults || {};
  const fieldKeys = [...new Set([...Object.keys(inspectionFieldLabels), ...Object.keys(fieldSuggestions), ...Object.keys(fieldResults)])]
    .filter((key) => inspectionFieldLabels[key]);
  const detectionCards = (inspection.detections || [])
    .map((item) => `
      <button
        type="button"
        class="inspection-card ${item.adapterId === selected.adapterId ? "inspection-card-selected" : ""}"
        data-detection-adapter="${escapeHtml(item.adapterId)}"
      >
        <div class="inspection-card-header">
          <strong>${escapeHtml(item.label)}</strong>
          ${renderStatusPill(item.confidence || "low", item.confidence === "high" ? "info" : item.confidence === "medium" ? "warn" : "manual")}
        </div>
        <div class="inspection-card-copy">score ${escapeHtml(String(item.score || 0))} &middot; ${item.matched ? "matched" : "fallback"}</div>
        <div class="inspection-card-copy">${escapeHtml((item.notes || []).join(" "))}</div>
      </button>
    `)
    .join("");
  const fieldRows = fieldKeys
    .map((key) => {
      const suggestion = fieldSuggestions[key] || null;
      const result = fieldResults[key] || null;
      const value = result?.value ?? effectiveSettings?.[key] ?? suggestion?.value ?? "";
      const confidence = suggestion?.confidence || "manual";
      const source = suggestion?.source || "current-settings";
      const message = result?.message || suggestion?.note || "";

      return `
        <tr>
          <td>${escapeHtml(inspectionFieldLabels[key])}</td>
          <td class="cell-truncate">${escapeHtml(value || "-")}</td>
          <td>${renderStatusPill(confidence, confidence === "high" ? "info" : confidence === "medium" ? "warn" : confidence === "low" ? "error" : "manual")}</td>
          <td>${result ? renderStatusPill(result.level || "info", result.level || "info") : renderStatusPill("manual", "manual")}</td>
          <td class="secondary-copy">${escapeHtml(message || source)}</td>
        </tr>
      `;
    })
    .join("");
  const diagnostics = (selected.diagnostics || inspection.diagnostics || [])
    .map((item) => `
      <tr>
        <td class="cell-truncate">${escapeHtml(item.binaryPath || "-")}</td>
        <td>${renderStatusPill(item.dockerOk ? "docker ok" : "docker fail", item.dockerOk ? "info" : "error")}</td>
        <td>${renderStatusPill(item.composeOk ? "compose ok" : "compose fail", item.composeOk ? "info" : "error")}</td>
        <td class="secondary-copy">${escapeHtml(item.dockerVersion || item.composeVersion || item.error || "-")}</td>
      </tr>
    `)
    .join("");
  const errors = validation?.errors || [];
  const warnings = validation?.warnings || [];

  return `
    <fieldset class="fieldset">
      <legend class="legend">Host Detection</legend>
      <div class="inspection-summary">
        <div>
          <div class="inspection-title">${escapeHtml(selected.label)}</div>
          <div class="inspection-copy">${escapeHtml((selected.notes || []).join(" "))}</div>
        </div>
        <div class="inspection-summary-badges">
          ${renderStatusPill(selected.confidence || "low", selected.confidence === "high" ? "info" : selected.confidence === "medium" ? "warn" : "manual")}
          ${renderStatusPill(validation?.ok === false ? `${errors.length} blocker(s)` : "validated", validation?.ok === false ? "error" : "info")}
        </div>
      </div>
      <div class="muted-paragraph">Click a host profile card to apply its defaults before saving.</div>
      ${detectionCards ? `<div class="inspection-grid">${detectionCards}</div>` : ""}
      ${errors.length
        ? `
          <div class="result-list result-list-danger">
            <strong>Blockers</strong>
            <ul>${errors.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
          </div>
        `
        : ""}
      ${warnings.length
        ? `
          <div class="result-list result-list-warning">
            <strong>Warnings</strong>
            <ul>${warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
          </div>
        `
        : ""}
      <table class="table-view inspection-table">
        <thead>
          <tr>
            <th style="width:18%;">Field</th>
            <th style="width:32%;">Value</th>
            <th style="width:14%;">Confidence</th>
            <th style="width:14%;">Status</th>
            <th style="width:22%;">Details</th>
          </tr>
        </thead>
        <tbody>${fieldRows}</tbody>
      </table>
      ${diagnostics
        ? `
          <div class="inspection-section-title">Docker Probes</div>
          <table class="table-view inspection-table">
            <thead>
              <tr>
                <th style="width:30%;">Binary</th>
                <th style="width:15%;">Docker</th>
                <th style="width:15%;">Compose</th>
                <th style="width:40%;">Version / Error</th>
              </tr>
            </thead>
            <tbody>${diagnostics}</tbody>
          </table>
        `
        : ""}
    </fieldset>
  `;
}

function renderSettingsView() {
  const hostFields = [
    {
      key: "projectName",
      label: "Project Name",
      help: "Used as the Compose project prefix."
    },
    {
      key: "hostUrl",
      label: "Public Host URL",
      help: "Base URL used for the Open links."
    },
    {
      key: "dockerBin",
      label: "Docker Binary",
      help: "Detected and validated on this host."
    },
    {
      key: "stackRoot",
      label: "Compose Stack Root",
      help: "Suggested from host detection. Does not exist yet and will be created.",
      browse: "directory"
    },
    {
      key: "tz",
      label: "Timezone",
      help: "Applied to every generated container."
    }
  ];

  const pathFields = [
    {
      key: "configRoot",
      label: "Config Root",
      help: "One subdirectory per app.",
      browse: "directory"
    },
    {
      key: "mediaRoot",
      label: "Media Root",
      help: "Confirm this before deploying - every app mounts it.",
      browse: "directory"
    },
    {
      key: "downloadsRoot",
      label: "Downloads Root",
      help: "Derived from Media Root.",
      browse: "directory"
    },
    {
      key: "plexLogsRoot",
      label: "Plex Logs Path",
      help: "Required while Tautulli is enabled.",
      placeholder: "/var/lib/plex/logs",
      browse: "directory"
    }
  ];

  const identityFields = [
    {
      key: "puid",
      label: "PUID",
      help: "User id passed to LinuxServer and similar images."
    },
    {
      key: "pgid",
      label: "PGID",
      help: "Group id passed to LinuxServer and similar images."
    }
  ];

  const advancedFields = [
    {
      key: "ombiVersion",
      label: "Ombi Version",
      help: "Pin a tag if you need a fixed release.",
      advanced: true
    }
  ];

  const backupFields = [
    {
      key: "backupRetention",
      label: "Backups Kept",
      help: "Every install, upgrade, and rollback saves a backup with a config snapshot. Older ones are pruned automatically. Keeping more lets you roll back further, at the cost of disk.",
      options: [
        { value: "1", label: "Only the latest (default)" },
        { value: "2", label: "Last 2" },
        { value: "3", label: "Last 3" },
        { value: "5", label: "Last 5" },
        { value: "10", label: "Last 10" },
        { value: "0", label: "Keep all (never prune)" }
      ]
    }
  ];

  const manageRows = appOrder()
    .map((id) => catalogMap().get(id))
    .filter(Boolean)
    .map((service) => renderManageRow(service))
    .join("");
  const actionHint = visibleWarningCount() > 0
    ? "Review warnings before deploying."
    : "Save settings first, then generate or deploy when you are ready.";

  return `
    <div data-screen-label="Settings" class="form-container">
      ${renderFirstRunGuide()}
      ${renderHostInspection()}
      <fieldset class="fieldset">
        <legend class="legend">Host</legend>
        ${hostFields.map((field) => renderInputRow(field)).join("")}
      </fieldset>
      <fieldset class="fieldset">
        <legend class="legend legend-secondary">Paths</legend>
        ${pathFields.map((field) => renderInputRow(field)).join("")}
      </fieldset>
      <fieldset class="fieldset">
        <legend class="legend legend-secondary">Runtime Identity</legend>
        ${identityFields.map((field) => renderInputRow(field)).join("")}
      </fieldset>
      <fieldset class="fieldset">
        <legend class="legend legend-secondary">Backups</legend>
        ${backupFields.map((field) => renderInputRow(field)).join("")}
      </fieldset>
      ${ui.advOpen && advancedFields.length
        ? `
          <fieldset class="fieldset">
            <legend class="legend legend-secondary">Advanced</legend>
            ${advancedFields.map((field) => renderInputRow(field)).join("")}
          </fieldset>
        `
        : ""}
      <fieldset class="fieldset">
        <legend class="legend">Apps To Manage</legend>
        <div class="manage-intro">${escapeHtml(`${selectedServiceIds().length} of ${state.catalog.length || 10} services selected. Keelarr generates and operates only what is checked.`)}</div>
        ${manageRows}
      </fieldset>
      <div class="action-row">
        <button type="button" class="button-default" data-settings-action="save">Save Settings</button>
        <button type="button" class="button-default" data-settings-action="save-generate">Save And Generate</button>
        <button type="button" class="button-success" data-settings-action="save-deploy">Save And Deploy</button>
        <span class="action-hint">${escapeHtml(actionHint)}</span>
      </div>
    </div>
  `;
}

function renderPathPicker() {
  if (!ui.pathPicker?.open) {
    return "";
  }

  const picker = ui.pathPicker;
  const directories = (picker.directories || [])
    .map((directory) => `
      <button type="button" class="path-picker-row" data-path-open="${escapeHtml(directory.path)}">
        <span><i class="fa-regular fa-folder"></i> ${escapeHtml(directory.name)}</span>
        <i class="fa-solid fa-angle-right"></i>
      </button>
    `)
    .join("");

  return `
    <div class="modal-backdrop" data-modal-backdrop="path">
      <div class="path-picker-modal" role="dialog" aria-modal="true" aria-label="Browse host directories">
        <div class="path-picker-header">
          <div>
            <div class="path-picker-title">${escapeHtml(`Browse ${picker.label || "Directory"}`)}</div>
            <div class="path-picker-copy">${escapeHtml(picker.path || "/")}</div>
          </div>
          <button type="button" class="toast-dismiss" data-path-close="true" aria-label="Close directory browser">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        ${picker.error
          ? `<div class="result-list result-list-danger"><strong>Browse failed</strong><ul><li>${escapeHtml(picker.error)}</li></ul></div>`
          : ""}
        <div class="path-picker-actions">
          <button type="button" class="button-default" data-path-use="true">Use This Folder</button>
          ${picker.parentPath ? `<button type="button" class="button-default" data-path-open="${escapeHtml(picker.parentPath)}">Up One Level</button>` : ""}
        </div>
        <div class="path-picker-list">
          ${directories || '<div class="muted-paragraph">No subdirectories are visible from this location.</div>'}
        </div>
      </div>
    </div>
  `;
}

/**
 * One place, because the panel title and the completion toast both need it and
 * a new job kind that reaches only one of them silently reports itself as a
 * cutover.
 */
// Polling survives a short outage rather than treating one failed request as
// proof the job is gone. Five attempts at two seconds covers a controller
// restart without leaving a dead loop claiming to still be trying.
const JOB_POLL_RETRY_MS = 2000;
const JOB_POLL_MAX_FAILURES = 5;

const JOB_KIND_LABELS = {
  "controller-update": "Keelarr Update",
  remove: "Removal",
  rollback: "Rollback",
  "upgrade-all": "Upgrade All",
  "cutover-revert": "Revert",
  wiring: "Wiring",
  cutover: "Cutover"
};

function jobKindLabel(kind) {
  return JOB_KIND_LABELS[kind] || JOB_KIND_LABELS.cutover;
}

const JOB_STEP_ICONS = {
  pending: { icon: "fa-regular fa-circle", tone: "idle" },
  running: { icon: "fa-solid fa-spinner fa-spin", tone: "info" },
  succeeded: { icon: "fa-solid fa-circle-check", tone: "good" },
  failed: { icon: "fa-solid fa-circle-xmark", tone: "danger" },
  skipped: { icon: "fa-solid fa-circle-minus", tone: "idle" }
};

function jobOutcomeBanner(job) {
  if (job.status === "running" || job.status === "pending") {
    return `<div class="job-banner job-banner-info"><i class="fa-solid fa-spinner fa-spin"></i> <span>Working. This can take a minute; you can leave this page open.</span></div>`;
  }

  if (job.status === "failed") {
    return `
      <div class="job-banner job-banner-danger">
        <i class="fa-solid fa-triangle-exclamation"></i>
        <span>
          ${escapeHtml(job.error?.message || "The job failed.")}
          ${job.error?.details?.reverted ? " The original container was restored." : ""}
        </span>
      </div>
    `;
  }

  // Upgrade All completes even when individual services fail, so a plain
  // success banner would hide the failures.
  if (job.result?.failed > 0) {
    return `
      <div class="job-banner job-banner-warn">
        <i class="fa-solid fa-triangle-exclamation"></i>
        <span>${escapeHtml(job.result.summary || "Some services failed to upgrade.")} Check the steps below.</span>
      </div>
    `;
  }

  // Succeeded, but health was never confirmed. Say so plainly rather than
  // showing an unqualified success.
  if (job.result?.outcome === "unverified") {
    return `
      <div class="job-banner job-banner-warn">
        <i class="fa-solid fa-triangle-exclamation"></i>
        <span>
          ${escapeHtml(job.result.serviceName || "The service")} is running under Compose, but its health could not be confirmed
          (${escapeHtml(job.result.health?.reason || "no healthcheck or app response")}).
          Check the app, then remove the rollback container yourself or revert.
        </span>
      </div>
    `;
  }

  return `
    <div class="job-banner job-banner-good">
      <i class="fa-solid fa-circle-check"></i>
      <span>${escapeHtml(job.result?.cleanupHint || "Done.")}</span>
    </div>
  `;
}

/**
 * Says whether this page can still see the job, which is a different question
 * from how the job is going. Once retries are exhausted the wording has to stop
 * claiming to be trying, because nothing is.
 */
function renderRecoveryBlock(command, lead) {
  if (!command) {
    return "";
  }

  return `
    <div class="recovery-block">
      <div class="recovery-lead">${escapeHtml(lead)}</div>
      <code class="recovery-command">${escapeHtml(command)}</code>
    </div>
  `;
}

/**
 * The update's own progress. Deliberately not the job panel: the job's reporter
 * is the process being replaced, so it cannot describe its own outcome, and
 * routing it there would leave a panel stuck at "running" for ever.
 */
function renderControllerUpdateBanner() {
  const watch = ui.controllerUpdate;

  if (!watch || watch.phase === "confirming") {
    return "";
  }

  const waited = watch.startedAt ? Math.round((Date.now() - watch.startedAt) / 1000) : 0;
  const dismiss = '<button type="button" class="job-banner-action" data-controller-action="dismiss">Dismiss</button>';

  if (watch.phase === "preparing") {
    return `<div class="job-banner job-banner-info"><i class="fa-solid fa-spinner fa-spin"></i><span><strong>Updating Keelarr</strong> — downloading ${escapeHtml(watch.toVersion || "")}. Nothing has been replaced yet.</span></div>`;
  }

  if (watch.phase === "handed-off" || watch.phase === "waiting") {
    const slow = waited > 45
      ? renderRecoveryBlock(watch.recoveryCommand, "Taking longer than usual. This puts it back on the version you were running:")
      : "";

    return `
      <div class="job-banner job-banner-info">
        <i class="fa-solid fa-spinner fa-spin"></i>
        <span>
          <strong>Keelarr is restarting on ${escapeHtml(watch.toVersion || "")}.</strong>
          This page has nothing to talk to until it comes back, which is expected rather than a failure.
          Leave the tab open and it reconnects on its own. Waited ${escapeHtml(String(waited))}s.
          ${slow}
        </span>
      </div>
    `;
  }

  if (watch.phase === "done") {
    return `<div class="job-banner job-banner-good"><i class="fa-solid fa-circle-check"></i><span><strong>Keelarr restarted on ${escapeHtml(watch.toVersion || "")}.</strong> It was on ${escapeHtml(watch.fromVersion || "")}.</span>${dismiss}</div>`;
  }

  if (watch.phase === "rolled-back") {
    return `<div class="job-banner job-banner-warn"><i class="fa-solid fa-rotate-left"></i><span><strong>The update did not take, and Keelarr was put back on ${escapeHtml(watch.fromVersion || "")}.</strong> ${escapeHtml(watch.detail || "")}</span>${dismiss}</div>`;
  }

  if (watch.phase === "mismatch" || watch.phase === "failed") {
    return `<div class="job-banner job-banner-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>${escapeHtml(watch.detail || "The update did not finish as expected.")}</span>${dismiss}</div>`;
  }

  return `
    <div class="job-banner job-banner-danger">
      <i class="fa-solid fa-plug-circle-xmark"></i>
      <span>
        <strong>Keelarr has not answered for ${escapeHtml(String(Math.round(waited / 60)))} minutes.</strong>
        It may still be starting, or the new version may not start at all. Nothing on this page can find out —
        this page can only ask Keelarr, and Keelarr is what is missing.
        ${renderRecoveryBlock(watch.recoveryCommand, "This puts it back on the version you were running:")}
        ${renderRecoveryBlock("docker logs keelarr", "This says why the new one did not start:")}
      </span>
      <button type="button" class="job-banner-action" data-controller-action="retry-probe">Try again now</button>
    </div>
  `;
}

function renderControllerUpdateModal() {
  const dialog = ui.controllerUpdate;

  if (!dialog?.dialogOpen) {
    return "";
  }

  if (dialog.readOnly) {
    return `
      <div class="modal-backdrop" data-modal-backdrop="controller-update">
        <div class="path-picker-modal" role="dialog" aria-modal="true">
          <div class="path-picker-header">
            <div>
              <div class="path-picker-title">Keelarr ${escapeHtml(dialog.toVersion || "")} is available</div>
              <div class="path-picker-copy">${escapeHtml(dialog.fromVersion || "")} is running now</div>
            </div>
          </div>
          <div class="muted-paragraph" style="margin:12px 0;">${escapeHtml(dialog.reason || "Keelarr will not replace its own container on this host.")}</div>
          ${renderRecoveryBlock(dialog.recoveryCommand, "So this one is yours to run:")}
          <div class="path-picker-actions">
            <button type="button" class="button-default" data-controller-action="close">Close</button>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="modal-backdrop" data-modal-backdrop="controller-update">
      <div class="path-picker-modal" role="dialog" aria-modal="true">
        <div class="path-picker-header">
          <div>
            <div class="path-picker-title">Update Keelarr to ${escapeHtml(dialog.toVersion || "")}</div>
            <div class="path-picker-copy">${escapeHtml(dialog.fromVersion || "")} &rarr; ${escapeHtml(dialog.toVersion || "")}</div>
          </div>
          <button type="button" class="toast-dismiss" data-controller-action="close" aria-label="Cancel">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        ${dialog.error ? `<div class="result-list result-list-danger"><strong>Could not start</strong><ul><li>${escapeHtml(dialog.error)}</li></ul></div>` : ""}
        <div class="muted-paragraph" style="margin:12px 0;">
          Keelarr downloads ${escapeHtml(dialog.toVersion || "")} and then replaces its own container with it. Your settings,
          activity, backups and the apps it manages are not touched — they live outside this container and keep running while it restarts.
        </div>
        <div class="muted-paragraph" style="margin:12px 0;">
          While the new container starts, this page has nothing to talk to. It will look frozen for a few seconds.
          Leave the tab open and it reconnects on its own and says what happened.
        </div>
        ${renderRecoveryBlock(dialog.recoveryCommand, "If it does not come back, this puts it back on the version you are running now. Run it on the host, wherever docker is available. Worth copying somewhere outside this page before you start — if Keelarr does not come back, neither does this page.")}
        <div class="path-picker-actions">
          <button type="button" class="button-default" data-controller-action="close">Cancel</button>
          <button type="button" class="button-success" data-controller-action="start" ${dialog.submitting ? "disabled" : ""}>
            ${dialog.submitting ? "Starting..." : `Update to ${escapeHtml(dialog.toVersion || "")}`}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderJobStaleBanner() {
  if (!ui.jobStale) {
    return "";
  }

  if (!ui.jobStaleFatal) {
    return `<div class="job-banner job-banner-warn"><i class="fa-solid fa-plug-circle-exclamation"></i><span>${escapeHtml(ui.jobStale)}</span></div>`;
  }

  return `
    <div class="job-banner job-banner-danger">
      <i class="fa-solid fa-plug-circle-xmark"></i>
      <span>Could not reconnect to Keelarr. The job may still be running on the host.</span>
      <button type="button" class="job-banner-action" data-job-action="retry">Retry</button>
    </div>
  `;
}

function renderJobPanel() {
  const job = ui.job;

  if (!job) {
    return "";
  }

  const steps = (job.steps || [])
    .map((step) => {
      const meta = JOB_STEP_ICONS[step.status] || JOB_STEP_ICONS.pending;
      const note = step.error || step.detail;

      return `
        <li class="job-step job-step-${escapeHtml(step.status)}">
          <i class="${escapeHtml(meta.icon)} job-step-icon job-step-icon-${escapeHtml(meta.tone)}"></i>
          <div>
            <div class="job-step-label">${escapeHtml(step.label || step.name)}</div>
            ${note ? `<div class="job-step-note">${escapeHtml(note)}</div>` : ""}
          </div>
        </li>
      `;
    })
    .join("");

  const title = jobKindLabel(job.kind);
  const subject = job.result?.serviceName
    || job.subject?.serviceId
    || job.subject?.containerId
    || "";

  return `
    <div class="job-panel">
      <div class="job-panel-header">
        <div>
          <div class="job-panel-title">${escapeHtml(title)}${subject ? ` &middot; ${escapeHtml(subject)}` : ""}</div>
          <div class="job-panel-copy">${escapeHtml(job.status)}</div>
        </div>
        ${job.status === "succeeded" || job.status === "failed"
          ? '<button type="button" class="toast-dismiss" data-job-action="dismiss" aria-label="Dismiss job"><i class="fa-solid fa-xmark"></i></button>'
          : ""}
      </div>
      ${jobOutcomeBanner(job)}
      ${renderJobStaleBanner()}
      <ol class="job-steps">${steps}</ol>
    </div>
  `;
}

function renderCutoverModal() {
  const dialog = ui.cutover;

  if (!dialog?.open) {
    return "";
  }

  const reverting = dialog.mode === "revert";
  const rollingBack = dialog.mode === "rollback";
  const confirmed = dialog.confirmText.trim() === dialog.containerName;
  const heading = rollingBack
    ? `Roll back ${dialog.serviceName}`
    : reverting
      ? `Revert ${dialog.serviceName}`
      : `Cut over ${dialog.serviceName} to Compose`;

  const explanation = rollingBack
    ? `Keelarr will back up the current state, pin the stack to <code>${escapeHtml(dialog.rollbackImage || "the previous image")}</code>, and recreate the container on it. If it does not come up, the newer image is restored automatically. Running an upgrade later clears the pin.`
    : reverting
      ? `Keelarr will stop and remove the Compose container, then rename <code>${escapeHtml(dialog.rollbackContainerName || "")}</code> back to <code>${escapeHtml(dialog.containerName)}</code> and start it.`
      : `Keelarr will back up the container, stop it, rename it to <code>${escapeHtml(dialog.containerName)}-keelarr-rollback</code>, then start the managed Compose stack. The original container is kept, not deleted, so this can be reverted.`;

  return `
    <div class="modal-backdrop" data-modal-backdrop="cutover">
      <div class="path-picker-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(heading)}">
        <div class="path-picker-header">
          <div>
            <div class="path-picker-title">${escapeHtml(heading)}</div>
            <div class="path-picker-copy">${escapeHtml(dialog.containerName)}</div>
          </div>
          <button type="button" class="toast-dismiss" data-cutover-close="true" aria-label="Cancel">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div class="muted-paragraph" style="margin:12px 0;">${explanation}</div>

        ${dialog.error
          ? `<div class="result-list result-list-danger"><strong>Could not start</strong><ul><li>${escapeHtml(dialog.error)}</li></ul></div>`
          : ""}

        ${rollingBack && dialog.hasConfigSnapshot
          ? `
            <label class="cutover-check">
              <input type="checkbox" data-cutover-restore-config="true" ${dialog.restoreConfig ? "checked" : ""} />
              <span>
                <strong>Also restore the saved configuration</strong>
                <span class="cutover-check-note">
                  Restores the database and settings captured ${escapeHtml(formatDate(dialog.snapshotTakenAt))}.
                  Needed when the newer version already migrated the database beyond what the older one can read.
                  <strong>Anything the app recorded since then is discarded.</strong>
                </span>
              </span>
            </label>
          `
          : rollingBack
            ? '<div class="muted-paragraph" style="margin-bottom:12px;">No configuration snapshot was captured for this rollback point, so only the image is reverted. If the newer version already migrated the database, the older image may not start.</div>'
            : ""}

        <label class="cutover-label" for="cutover-confirm">
          Type <strong>${escapeHtml(dialog.containerName)}</strong> to confirm
        </label>
        <input
          id="cutover-confirm"
          class="text-input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          value="${escapeHtml(dialog.confirmText)}"
          data-cutover-input="true"
        />

        <div class="path-picker-actions" style="justify-content:flex-end;">
          <button type="button" class="button-default" data-cutover-close="true">Cancel</button>
          <button
            type="button"
            class="${reverting || rollingBack ? "button-default" : "button-success"}"
            data-cutover-action="submit"
            ${confirmed && !dialog.submitting ? "" : "disabled"}
          >
            ${dialog.submitting ? "Starting..." : rollingBack ? "Roll Back" : reverting ? "Revert" : "Cut Over"}
          </button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Keelarr's own version currency, in the same language the stack table uses for
 * every other app: the version string is coloured, and the reason it cannot be
 * updated is printed as found rather than mapped to a second copy of the
 * sentence here.
 */
function renderControllerVersion() {
  const update = state.meta?.selfUpdate || null;
  const version = `${escapeHtml(appDisplayName())} ${escapeHtml(appVersion())}`;

  if (!update) {
    return version;
  }

  if (ui.controllerCheckBusy) {
    return `${version} &middot; <span class="footer-update-note"><i class="fa-solid fa-spinner fa-spin"></i> checking</span>`;
  }

  if (update.updateStatus === "ready" && update.available) {
    return `<span class="version-stale">${version}</span> &middot; <button type="button" class="footer-update-button" data-controller-action="open" title="Keelarr ${escapeHtml(update.targetVersion)} is published.">Update to ${escapeHtml(update.targetVersion)}</button>`;
  }

  if (update.updateStatus === "ready" && !update.available) {
    // A newer release exists but this host cannot take it. Saying only "update
    // available" would offer something that is not on offer.
    return `<span class="version-stale">${version}</span> &middot; <span class="footer-update-note" title="${escapeHtml(update.reason || "")}">${escapeHtml(update.targetVersion)} available, not from here</span>`;
  }

  if (update.updateStatus === "current") {
    return `<span class="version-current">${version}</span> &middot; <span class="footer-update-note">up to date</span>`;
  }

  const note = update.checkError ? `check failed: ${update.checkError}` : "update status unknown";

  return `<span class="version-unknown">${version}</span> &middot; <button type="button" class="footer-update-button" data-controller-action="check" title="${escapeHtml(note)}">Check for an update</button>`;
}

function renderFooter() {
  const services = selectedServices();
  const running = services.filter((service) => isServiceRunning(service)).length;
  const warnings = visibleWarningCount() > 0 ? "1 warning" : "no warnings";

  return `
    <span>${escapeHtml(String(services.length))} apps &middot; ${escapeHtml(String(running))} running &middot; ${escapeHtml(warnings)} &middot; PUID ${escapeHtml(state.settings?.puid || "911")} / PGID ${escapeHtml(state.settings?.pgid || "911")}</span>
    <span>
      ${renderControllerVersion()} &middot; compose-native ARR control plane${SUPPORT_URL
        ? ` &middot; <a class="footer-support" href="${escapeHtml(SUPPORT_URL)}" target="_blank" rel="noopener noreferrer">Support Keelarr</a>`
        : ""}
    </span>
  `;
}

function renderCurrentView() {
  if (ui.view === "stack") {
    return renderStackView();
  }

  if (ui.view === "adoption") {
    return renderAdoptionView();
  }

  if (ui.view === "activity") {
    return renderActivityView();
  }

  return renderSettingsView();
}

/**
 * The sign-in screen, shown instead of the dashboard.
 *
 * It deliberately renders on its own rather than as a modal over the stack:
 * with no session there is no state to show behind it, and a blurred-out
 * dashboard would only imply otherwise.
 */
function renderAuthGate() {
  const firstRun = !state.auth?.configured;
  const minLength = state.auth?.minPasswordLength || 8;

  appNode.innerHTML = `
    <div class="auth-shell">
      <form class="auth-card" data-auth-form>
        <div class="brand-mark auth-mark">KA</div>
        <h1 class="auth-title">${firstRun ? "Set a password" : "Sign in"}</h1>
        <p class="auth-lead">
          ${firstRun
            ? `Keelarr controls Docker on this machine, so it needs a password before it will do anything else. Choose one of at least ${minLength} characters.`
            : "Enter the password you set for this Keelarr."}
        </p>
        <label class="auth-field">
          <span>Password</span>
          <input
            type="password"
            name="authPassword"
            autocomplete="${firstRun ? "new-password" : "current-password"}"
            value="${escapeHtml(ui.authPassword)}"
            autofocus
          >
        </label>
        ${firstRun ? `
          <label class="auth-field">
            <span>Confirm password</span>
            <input type="password" name="authConfirm" autocomplete="new-password" value="${escapeHtml(ui.authConfirm)}">
          </label>
        ` : ""}
        ${ui.authError ? `<p class="auth-error">${escapeHtml(ui.authError)}</p>` : ""}
        <button class="button button-primary auth-submit" type="submit" ${ui.authBusy ? "disabled" : ""}>
          ${ui.authBusy ? "Working..." : (firstRun ? "Set password and continue" : "Sign in")}
        </button>
        ${firstRun ? `
          <p class="auth-note">
            There is no password reset. If you lose it, delete <code>auth.json</code> from Keelarr's data directory and this screen comes back.
          </p>
        ` : ""}
      </form>
    </div>
  `;

  appNode.querySelector('input[name="authPassword"]')?.focus();
}

/**
 * The first screen, before there is a dashboard to render.
 *
 * A controller that cannot be reached used to leave this on "Loading..."
 * forever: render() returns here before any toast is painted, so the error was
 * raised into a page that could not show it, with nothing to retry and no way
 * back once the controller returned.
 */
function renderBootstrapState() {
  if (!ui.bootstrapError) {
    return "Loading...";
  }

  return `
    <div class="result-panel result-panel-danger">
      <div class="result-panel-title">Cannot reach Keelarr.</div>
      <div class="result-panel-copy">${escapeHtml(ui.bootstrapError)}</div>
      <div class="result-panel-copy">The page loaded, but Keelarr is not answering. If it was just restarted, give it a moment.</div>
      <button type="button" class="button-default" data-bootstrap-action="retry">Try again</button>
    </div>
  `;
}

function render() {
  if (state.auth && state.auth.required && !state.auth.authenticated) {
    renderAuthGate();
    return;
  }

  if (!state.settings) {
    appNode.innerHTML = `<div class="app-shell"><div class="page-content">${renderControllerUpdateBanner()}${renderBootstrapState()}</div></div>`;
    return;
  }

  // Every render replaces the whole tree, which resets scroll to the top.
  // Toggling a checkbox halfway down Settings should not throw you back up.
  const previousScroll = appNode.querySelector(".scroll-shell")?.scrollTop ?? 0;

  try {
    document.title = `${appDisplayName()} v${appVersion()}`;

    appNode.innerHTML = `
      <div class="app-shell">
        <header class="app-header">
          <div class="brand-slot">
            <div class="brand-mark">KA</div>
            <span class="brand-wordmark">${escapeHtml(appDisplayName())}</span>
          </div>
          <div class="header-search">
            <div class="search-shell" aria-hidden="true">
              <i class="fa-solid fa-magnifying-glass"></i>
              <span class="search-input search-input-static">Search apps</span>
            </div>
          </div>
          <div class="header-icons">
            <span class="header-icon header-icon-warning" aria-hidden="true"><i class="fa-solid fa-triangle-exclamation"></i></span>
            ${SUPPORT_URL
              ? `<a class="header-icon header-icon-donate" href="${escapeHtml(SUPPORT_URL)}" target="_blank" rel="noopener noreferrer" title="Support Keelarr"><i class="fa-solid fa-heart"></i></a>`
              : ""}
            ${state.auth?.required
              ? '<button class="header-icon header-icon-account" type="button" data-auth-signout title="Sign out"><i class="fa-solid fa-arrow-right-from-bracket"></i></button>'
              : '<span class="header-icon header-icon-account" aria-hidden="true"><i class="fa-solid fa-user"></i></span>'}
          </div>
        </header>
        <div class="app-body">
          <aside class="sidebar">
            <nav class="sidebar-nav">${renderSidebarNav()}</nav>
            ${renderHostSummary()}
          </aside>
          <main class="main-shell">
            ${renderToolbar()}
        <div class="scroll-shell">
          <div class="page-content">
            ${renderWarningBanner()}
            ${renderControllerUpdateBanner()}
      ${renderJobPanel()}
            ${renderResultPanel()}
            ${renderCurrentView()}
          </div>
          <div class="page-footer">${renderFooter()}</div>
            </div>
          </main>
        </div>
        ${renderToast()}
        ${renderBusyBanner()}
        ${renderPathPicker()}
        ${renderCutoverModal()}
  ${renderControllerUpdateModal()}
        ${renderRemovalModal()}
        ${renderWiringModal()}
      </div>
    `;

    // Re-focus the confirmation field after the full re-render so typing is
    // not interrupted by each keystroke rebuilding the DOM.
    for (const selector of ["[data-cutover-input]", "[data-removal-input]"]) {
      const input = appNode.querySelector(selector);
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        break;
      }
    }
    const scroller = appNode.querySelector(".scroll-shell");
    if (scroller && previousScroll > 0) {
      scroller.scrollTop = previousScroll;
    }

    window.__keelarrRenderError = null;
  } catch (error) {
    window.__keelarrRenderError = error?.message || "Render failed.";
    console.error(error);
    appNode.innerHTML = `
      <div class="app-shell">
        <div class="page-content">
          <div class="result-panel result-panel-danger">
            <div class="result-panel-title">UI render failed</div>
            <div class="result-panel-copy">${escapeHtml(error?.message || "Unexpected render error.")}</div>
          </div>
        </div>
      </div>
    `;
  }
}

function setLatestResult(title, data) {
  ui.latestResult = {
    title,
    data
  };
}

function toggleSelectedService(serviceId) {
  const selected = new Set(selectedServiceIds());
  if (selected.has(serviceId)) {
    selected.delete(serviceId);
  } else {
    selected.add(serviceId);
  }

  state.settings = {
    ...state.settings,
    selectedServiceIds: appOrder().filter((id) => selected.has(id))
  };
  render();
}

function updateSettingValue(key, value) {
  state.settings = {
    ...state.settings,
    [key]: value
  };
}

function settingsPayload(options = {}) {
  const {
    deploy = false,
    preferredAdapterId = null
  } = options;

  return {
    projectName: state.settings.projectName,
    adapterType: state.settings.adapterType,
    hostLabel: state.settings.hostLabel,
    hostUrl: state.settings.hostUrl,
    dockerBin: state.settings.dockerBin,
    stackRoot: state.settings.stackRoot,
    configRoot: state.settings.configRoot,
    mediaRoot: state.settings.mediaRoot,
    downloadsRoot: state.settings.downloadsRoot,
    plexLogsRoot: state.settings.plexLogsRoot,
    tz: state.settings.tz,
    puid: state.settings.puid,
    pgid: state.settings.pgid,
    ombiVersion: state.settings.ombiVersion,
    backupRetention: state.settings.backupRetention,
    selectedServiceIds: selectedServiceIds(),
    ...(preferredAdapterId ? { preferredAdapterId } : {}),
    deploy
  };
}

async function loadAuth() {
  const response = await fetch("/api/auth/status", { cache: "no-store" });

  // Parsing first and asking questions later turned "the app is not answering"
  // into a JSON syntax error about a DOCTYPE — true, and no help at all to
  // someone whose controller is down behind a proxy that still serves this page.
  if (!response.ok) {
    throw new Error(`Keelarr answered ${response.status}.`);
  }

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error("The reply was not JSON. Something other than Keelarr may be answering on this address.");
  }

  state.auth = data;
  return data;
}

async function submitAuth() {
  // A second Enter while the first is still in flight would otherwise send the
  // password twice and race two renders.
  if (ui.authBusy) {
    return;
  }

  const firstRun = !state.auth?.configured;
  const password = ui.authPassword;

  if (firstRun && password !== ui.authConfirm) {
    ui.authError = "Those two passwords do not match.";
    render();
    return;
  }

  ui.authBusy = true;
  ui.authError = null;
  render();

  try {
    await request(firstRun ? "/api/auth/setup" : "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password })
    });
    // Cleared on the way in rather than held for a retry: nothing else in the
    // page has any use for it.
    ui.authPassword = "";
    ui.authConfirm = "";
    state.auth = { ...state.auth, configured: true, authenticated: true };
    await loadState();
    await reattachJob().catch(() => {});
  } catch (error) {
    ui.authError = error.message;
    state.auth = { ...state.auth, authenticated: false };
  } finally {
    ui.authBusy = false;
    render();
  }
}

async function signOut() {
  await fetch("/api/auth/logout", { method: "POST" });
  state.auth = { ...state.auth, authenticated: false };
  state.settings = null;
  ui.authPassword = "";
  ui.authConfirm = "";
  ui.authError = null;
  render();
}

/**
 * Asks the controller to look for a newer release. Nothing is downloaded, so
 * this deliberately does not take over the screen with runBusy the way an
 * install does.
 */
function readControllerUpdateWatch() {
  try {
    const record = JSON.parse(window.localStorage.getItem(CONTROLLER_UPDATE_KEY) || "null");

    // The code reading this record is served by the image the update installed,
    // so a record it does not recognise has to be ignored rather than crash the
    // bootstrap of a controller that just came up.
    if (!record || record.v !== 1) {
      return null;
    }

    if (Date.now() - record.startedAt > CONTROLLER_UPDATE_STALE_MS) {
      forgetControllerUpdateWatch();
      return null;
    }

    return record;
  } catch {
    return null;
  }
}

function rememberControllerUpdateWatch(record) {
  try {
    window.localStorage.setItem(CONTROLLER_UPDATE_KEY, JSON.stringify(record));
  } catch {
    // A private window still gets the banner; it just cannot survive a reload.
  }
}

function forgetControllerUpdateWatch() {
  try {
    window.localStorage.removeItem(CONTROLLER_UPDATE_KEY);
  } catch {
    // Nothing to clean up.
  }
}

function stopControllerWatch() {
  if (ui.controllerUpdateTimer) {
    clearTimeout(ui.controllerUpdateTimer);
    ui.controllerUpdateTimer = null;
  }
}

/**
 * Asks whether the controller is back, without any of request()'s behaviour.
 *
 * request() parses before checking the status, so a proxy's HTML 502 arrives as
 * a JSON syntax error rather than "not yet"; it throws on any non-200, turning
 * an expected outage into a stream of exceptions; and its 401 branch would drop
 * the page to the sign-in gate from inside a background timer.
 */
async function probeController() {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });

    if (response.status === 401) {
      return { up: true, authed: false };
    }

    if (!response.ok) {
      return { up: false };
    }

    return { up: true, authed: true, data: await response.json() };
  } catch {
    return { up: false };
  }
}

function controllerProbeDelay(elapsed) {
  return (CONTROLLER_PROBE_STEPS.find(([limit]) => elapsed < limit) || CONTROLLER_PROBE_STEPS.at(-1))[1];
}

async function watchControllerRestart() {
  stopControllerWatch();

  const watch = ui.controllerUpdate;

  if (!watch || !["handed-off", "waiting"].includes(watch.phase)) {
    return;
  }

  const elapsed = Date.now() - watch.startedAt;

  if (elapsed > watch.deadlineMs) {
    watch.phase = "timeout";
    render();
    return;
  }

  const probe = await probeController();

  if (!probe.up) {
    watch.attempts = (watch.attempts || 0) + 1;
    render();
    ui.controllerUpdateTimer = setTimeout(() => watchControllerRestart(), controllerProbeDelay(elapsed));
    return;
  }

  if (!probe.authed) {
    // Back, but the session did not survive. Verification resumes after sign-in.
    state.auth = { ...(state.auth || {}), required: true, authenticated: false };
    render();
    return;
  }

  finishControllerUpdate(watch, probe.data);
}

/**
 * Decides what actually happened, by version rather than by liveness.
 *
 * The old container answers perfectly well for the first seconds of the window,
 * so treating any answer as success would report a victory on the version the
 * update was trying to leave.
 */
function finishControllerUpdate(watch, data) {
  const observed = data?.meta?.version || null;
  const result = data?.meta?.selfUpdate?.lastResult || null;
  const mine = result && result.operationId === watch.operationId ? result : null;

  if (mine && mine.outcome === "rolled-back") {
    watch.phase = "rolled-back";
    watch.detail = mine.detail;
    forgetControllerUpdateWatch();
  } else if (observed && observed === watch.toVersion) {
    watch.phase = "done";
    forgetControllerUpdateWatch();
  } else if (observed === watch.fromVersion) {
    watch.firstContactAt = watch.firstContactAt || Date.now();

    if (Date.now() - watch.firstContactAt < SAME_VERSION_GRACE_MS) {
      applyState(data);
      ui.controllerUpdateTimer = setTimeout(() => watchControllerRestart(), 2000);
      return;
    }

    watch.phase = "failed";
    watch.detail = `Keelarr answered again, but it is still on ${observed}. Nothing was replaced.`;
    forgetControllerUpdateWatch();
  } else {
    watch.phase = "mismatch";
    watch.detail = `Keelarr came back on ${observed || "an unknown version"}, not the ${watch.toVersion} this started for.`;
    forgetControllerUpdateWatch();
  }

  stopControllerWatch();
  applyState(data);
}

function openControllerUpdateDialog() {
  const update = state.meta?.selfUpdate;

  ui.controllerUpdate = {
    dialogOpen: true,
    readOnly: !update?.available,
    submitting: false,
    error: null,
    phase: "confirming",
    fromVersion: update?.currentVersion || appVersion(),
    toVersion: update?.targetVersion || null,
    reason: update?.reason || null,
    recoveryCommand: update?.recoveryCommand || null
  };
  render();
}

function closeControllerUpdateDialog() {
  if (ui.controllerUpdate?.phase === "confirming") {
    ui.controllerUpdate = null;
  } else if (ui.controllerUpdate) {
    ui.controllerUpdate.dialogOpen = false;
  }

  render();
}

async function startControllerUpdate() {
  const dialog = ui.controllerUpdate;

  if (!dialog || dialog.submitting || dialog.readOnly) {
    return;
  }

  dialog.submitting = true;
  dialog.phase = "preparing";
  render();

  // Logged before anything is at risk: after the container goes, so does this
  // page and everything printed on it.
  if (dialog.recoveryCommand) {
    console.info(`Keelarr update: if it does not come back, run\n${dialog.recoveryCommand}`);
  }

  try {
    const data = await request("/api/self-update", {
      method: "POST",
      body: JSON.stringify({ version: dialog.toVersion })
    });

    dialog.dialogOpen = false;
    dialog.jobId = data.job?.id || null;
    dialog.operationId = data.job?.subject?.operationId || null;
    dialog.startedAt = Date.now();
    dialog.attempts = 0;
    // Two verification windows plus the recreate, taken from what the backend
    // said rather than a number guessed here.
    dialog.deadlineMs = (data.job?.result?.deadlineMs) || 8 * 60 * 1000;
    dialog.phase = "handed-off";

    rememberControllerUpdateWatch({
      v: 1,
      operationId: dialog.operationId,
      jobId: dialog.jobId,
      fromVersion: dialog.fromVersion,
      toVersion: dialog.toVersion,
      startedAt: dialog.startedAt,
      deadlineMs: dialog.deadlineMs,
      recoveryCommand: dialog.recoveryCommand
    });

    render();
    watchControllerRestart();
  } catch (error) {
    dialog.submitting = false;
    dialog.phase = "confirming";
    dialog.error = error.message;
    render();
  }
}

async function checkControllerUpdate() {
  if (ui.controllerCheckBusy) {
    return;
  }

  ui.controllerCheckBusy = true;
  render();

  try {
    await request("/api/self-update/check", { method: "POST" });
    await loadState();
  } finally {
    ui.controllerCheckBusy = false;
    render();
  }
}

async function loadState() {
  applyState(await request("/api/state"));
}

/**
 * Adopts a /api/state payload. Split from loadState so a caller that already
 * holds one — having fetched it to find out whether the controller is back —
 * can use it instead of asking again.
 */
function applyState(data) {
  state.configured = data.configured === true;
  state.catalog = data.catalog;
  state.settings = data.settings;
  state.services = data.services;
  state.diagnostics = data.diagnostics;
  state.activity = data.activity;
  state.hostDetection = data.hostDetection || null;
  state.meta = data.meta || null;
  if (!state.configured && ui.view === "stack") {
    ui.view = "settings";
  }
  render();
}

async function submitSetup(deploy = false) {
  const data = await request("/api/setup", {
    method: "POST",
    body: JSON.stringify(settingsPayload({ deploy }))
  });
  setLatestResult(deploy ? "Save And Deploy" : "Save And Generate", data);
  ui.view = "stack";
  showToast(deploy ? "Settings saved and selected stacks deployed." : "Settings saved and stack files generated.", "success");
  await loadState();
}

async function saveSettingsOnly() {
  const data = await request("/api/settings", {
    method: "POST",
    body: JSON.stringify(settingsPayload())
  });
  setLatestResult("Settings Saved", data);
  ui.view = "settings";

  // Host paths live in two places by necessity: here, and in the controller's
  // own Compose env file, which has to exist before the container it configures
  // does. Keelarr keeps that file in step, but only a recreate applies it —
  // saying so beats leaving it to be discovered when a path reads as missing.
  const env = data.controllerEnv;

  if (env && !env.written) {
    showToast(env.message || "Host settings saved, but deploy/.env could not be updated.", "warn");
  } else if (env?.pathsChanged) {
    showToast("Host settings saved. Recreate the Keelarr container to apply the new paths.", "warn");
  } else {
    showToast("Host settings saved.", "success");
  }

  await loadState();
}

async function detectHost(preferredAdapterId = null) {
  const data = await request("/api/host/detect", {
    method: "POST",
    body: JSON.stringify(settingsPayload({ preferredAdapterId }))
  });
  state.hostDetection = data;
  state.settings = data.effectiveSettings || {
    ...state.settings,
    ...(data.selected?.suggestedSettings || {})
  };
  setLatestResult("Host Detection", data);
  render();
}

async function browseHostDirectories(fieldKey, inputPath = null) {
  const fieldLabel = inspectionFieldLabels[fieldKey] || fieldKey;
  const pathToBrowse = normalizeBrowsePath(inputPath ?? state.settings?.[fieldKey] ?? "/");

  try {
    const data = await request(`/api/host/browse?path=${encodeURIComponent(pathToBrowse)}`);
    ui.pathPicker = {
      open: true,
      fieldKey,
      label: fieldLabel,
      path: data.path,
      parentPath: data.parentPath,
      directories: data.directories || [],
      error: null
    };
  } catch (error) {
    ui.pathPicker = {
      open: true,
      fieldKey,
      label: fieldLabel,
      path: pathToBrowse,
      parentPath: null,
      directories: [],
      error: error.message
    };
  }

  render();
}

function closePathPicker() {
  ui.pathPicker = null;
  render();
}

function applyPathPickerSelection() {
  if (!ui.pathPicker?.fieldKey || !ui.pathPicker?.path) {
    closePathPicker();
    return;
  }

  updateSettingValue(ui.pathPicker.fieldKey, ui.pathPicker.path);
  ui.pathPicker = null;
  render();
}

async function scanImports(preservePreview = false) {
  const data = await request("/api/import/scan");
  state.importScan = data;
  if (!preservePreview) {
    state.importPreview = null;
    ui.selectedImportContainerId = null;
  }
  setLatestResult("Import Scan", data);
  render();
}

async function previewImport(containerId) {
  const data = await request(`/api/import/${containerId}/preview`);
  state.importPreview = data;
  ui.selectedImportContainerId = containerId;
  setLatestResult("Import Preview", data);
  render();
}

async function adoptImportDraft(containerId) {
  const data = await request(`/api/import/${containerId}/adopt-draft`, {
    method: "POST"
  });
  setLatestResult("Adopt Import Draft", data);
  state.importPreview = data.preview || null;
  await loadState();
  if (state.importScan) {
    await scanImports(true);
  }
}

function openCutoverDialog({ mode, containerId, serviceId, serviceName, containerName, rollbackContainerName, rollbackImage, hasConfigSnapshot, snapshotTakenAt }) {
  ui.cutover = {
    open: true,
    mode,
    containerId: containerId || null,
    serviceId: serviceId || null,
    serviceName: serviceName || containerName,
    containerName,
    rollbackContainerName: rollbackContainerName || null,
    rollbackImage: rollbackImage || null,
    hasConfigSnapshot: hasConfigSnapshot === true,
    snapshotTakenAt: snapshotTakenAt || null,
    restoreConfig: false,
    confirmText: "",
    submitting: false,
    error: null
  };
  render();
}

/**
 * Loads a real preview before asking anything. The operator sees actual paths
 * and sizes rather than guessing what a checkbox will delete.
 */
async function openRemovalDialog(serviceId) {
  const preview = await request(`/api/services/${serviceId}/removal-preview`);
  ui.removal = {
    open: true,
    preview,
    confirmText: "",
    removeConfig: false,
    removeImage: false,
    removeBackups: false,
    submitting: false,
    error: null
  };
  render();
}

function closeRemovalDialog() {
  ui.removal = null;
  render();
}

async function submitRemoval() {
  const dialog = ui.removal;

  if (!dialog || dialog.confirmText.trim() !== dialog.preview.containerName) {
    return;
  }

  dialog.submitting = true;
  dialog.error = null;
  render();

  try {
    const data = await request(`/api/services/${dialog.preview.serviceId}/remove`, {
      method: "POST",
      body: JSON.stringify({
        confirmContainerName: dialog.preview.containerName,
        removeConfig: dialog.removeConfig,
        removeImage: dialog.removeImage,
        removeBackups: dialog.removeBackups
      })
    });

    ui.removal = null;
    ui.job = data.job;
    render();
    await pollJob(data.job.id);
  } catch (error) {
    if (ui.removal) {
      ui.removal.submitting = false;
      ui.removal.error = error.message;
    }
    render();
  }
}

function renderRemovalModal() {
  const dialog = ui.removal;

  if (!dialog?.open) {
    return "";
  }

  const p = dialog.preview;
  const confirmed = dialog.confirmText.trim() === p.containerName;
  const t = p.targets;

  const choice = (key, label, note, checked) => `
    <label class="cutover-check">
      <input type="checkbox" data-removal-option="${key}" ${checked ? "checked" : ""} />
      <span>
        <strong>${escapeHtml(label)}</strong>
        <span class="cutover-check-note">${note}</span>
      </span>
    </label>
  `;

  return `
    <div class="modal-backdrop" data-modal-backdrop="removal">
      <div class="path-picker-modal" role="dialog" aria-modal="true" aria-label="Remove ${escapeHtml(p.serviceName)}">
        <div class="path-picker-header">
          <div>
            <div class="path-picker-title">Remove ${escapeHtml(p.serviceName)}</div>
            <div class="path-picker-copy">${escapeHtml(p.containerName)}</div>
          </div>
          <button type="button" class="toast-dismiss" data-removal-close="true" aria-label="Cancel">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        ${p.warnings.map((w) => `
          <div class="result-list result-list-warning"><strong>Other apps depend on this</strong><ul><li>${escapeHtml(w.message)}</li></ul></div>
        `).join("")}

        ${p.imported
          ? '<div class="result-list result-list-warning"><strong>Imported service</strong><ul><li>This container existed before Keelarr managed it. Removing it deletes a container you created yourself.</li></ul></div>'
          : ""}

        <div class="muted-paragraph" style="margin:12px 0 6px;">Always removed:</div>
        <ul class="removal-list">
          <li>${escapeHtml(t.container.label)}</li>
          <li>${escapeHtml(t.stack.label)} <span class="removal-path">${escapeHtml(t.stack.path)}</span></li>
        </ul>

        <div class="muted-paragraph" style="margin:14px 0 6px;">Choose what else to delete:</div>
        ${t.config?.absent
          ? '<div class="muted-paragraph" style="margin-bottom:12px;">No configuration or database exists on disk for this app, so there is nothing to keep or delete.</div>'
          : choice("removeConfig", `Delete ${t.config.label.toLowerCase()}`,
              `${escapeHtml(t.config.path)}${t.config.size ? ` &middot; ${escapeHtml(t.config.size)}` : ""}. This is the app's database and settings. Keeping it lets you reinstall exactly where you left off.${t.config.inferred ? " (Container is not running; this is the standard path for this app.)" : ""}`,
              dialog.removeConfig)}
        ${choice("removeImage", `Delete the image ${t.image.label}`,
            "Only affects disk space. It is re-pulled on the next install, and is kept automatically if another service still uses it.",
            dialog.removeImage)}
        ${choice("removeBackups", "Delete Keelarr backups",
            `${escapeHtml(t.backups.path)}. Includes config snapshots taken before upgrades, which are what make a rollback possible.`,
            dialog.removeBackups)}

        ${dialog.removeConfig
          ? `<div class="result-list result-list-warning">
               <strong>Reinstalling would start ${escapeHtml(p.serviceName)} from scratch</strong>
               <ul><li>Its settings, library, and any indexer or account details inside it are deleted with the
               configuration. A later install would be a brand new app.</li></ul>
             </div>`
          : `<div class="removal-preserved">
               <i class="fa-solid fa-rotate-left"></i>
               <span>
                 <strong>Reinstalling brings ${escapeHtml(p.serviceName)} back as it is now.</strong>
                 Keelarr keeps a record of what this app was and where its stack files are archived, so a later
                 install restores this exact service rather than a fresh one — settings, library, and anything
                 configured inside it included.
               </span>
             </div>`}

        ${p.stillReferencedBy
          ? `<div class="removal-preserved removal-referenced">
               <i class="fa-solid fa-link-slash"></i>
               <span><strong>Will still point at this:</strong> ${escapeHtml(p.stillReferencedBy.note)}</span>
             </div>`
          : ""}

        <div class="removal-preserved">
          <i class="fa-solid fa-shield-halved"></i>
          <span>
            <strong>Never touched:</strong>
            ${p.preserved.map((item) => `${escapeHtml(item.label)} (<code>${escapeHtml(item.path)}</code>)`).join(" and ")}.
            ${escapeHtml(p.preserved[0].reason)}
          </span>
        </div>

        ${dialog.error
          ? `<div class="result-list result-list-danger"><strong>Could not remove</strong><ul><li>${escapeHtml(dialog.error)}</li></ul></div>`
          : ""}

        <label class="cutover-label" for="removal-confirm">
          Type <strong>${escapeHtml(p.containerName)}</strong> to confirm
        </label>
        <input id="removal-confirm" class="text-input" type="text" autocomplete="off" spellcheck="false"
          value="${escapeHtml(dialog.confirmText)}" data-removal-input="true" />

        <div class="path-picker-actions" style="justify-content:flex-end;">
          <button type="button" class="button-default" data-removal-close="true">Cancel</button>
          <button type="button" class="button-danger" data-removal-action="submit" ${confirmed && !dialog.submitting ? "" : "disabled"}>
            ${dialog.submitting ? "Removing..." : "Remove"}
          </button>
        </div>
      </div>
    </div>
  `;
}

async function openWiringDialog() {
  ui.wiring = { open: true, report: await request("/api/wiring/check"), submitting: false, error: null };
  render();
}

function closeWiringDialog() {
  ui.wiring = null;
  render();
}

/**
 * Every state gets a tone and a plain-language label, because the whole point
 * of the report is that "not configured" and "cannot be configured on this
 * host" are different problems with different fixes.
 */
const WIRING_STATE_META = {
  correct: { tone: "ok", icon: "fa-solid fa-circle-check", label: "Connected" },
  drift: { tone: "warn", icon: "fa-solid fa-circle-exclamation", label: "Points elsewhere" },
  ambiguous: { tone: "warn", icon: "fa-solid fa-code-branch", label: "Ambiguous" },
  absent: { tone: "warn", icon: "fa-solid fa-circle-minus", label: "Not configured" },
  blocked: { tone: "danger", icon: "fa-solid fa-ban", label: "Blocked" },
  unknown: { tone: "muted", icon: "fa-solid fa-circle-question", label: "Unreadable" },
  "not-applicable": { tone: "muted", icon: "fa-solid fa-minus", label: "Not applicable" },
  "not-needed": { tone: "ok", icon: "fa-solid fa-circle-check", label: "Not needed" }
};

const WIRING_READINESS_META = {
  ready: { tone: "ok", icon: "fa-solid fa-circle-check" },
  "needs-you": { tone: "warn", icon: "fa-solid fa-hand" },
  incomplete: { tone: "warn", icon: "fa-solid fa-triangle-exclamation" },
  blocked: { tone: "danger", icon: "fa-solid fa-ban" },
  pending: { tone: "muted", icon: "fa-solid fa-hourglass-half" }
};

function renderWiringRow({ title, subtitle, state, reason, detail, test }) {
  const meta = WIRING_STATE_META[state] || WIRING_STATE_META.unknown;

  return `
    <li class="wiring-row wiring-row-${meta.tone}">
      <span class="wiring-row-icon" title="${escapeHtml(meta.label)}"><i class="${meta.icon}"></i></span>
      <span class="wiring-row-body">
        <span class="wiring-row-title">
          ${escapeHtml(title)}
          <span class="wiring-row-state">${escapeHtml(meta.label)}</span>
        </span>
        ${subtitle ? `<span class="wiring-row-address"><code>${escapeHtml(subtitle)}</code></span>` : ""}
        <span class="wiring-row-reason">${escapeHtml(reason || "")}</span>
        ${detail ? `<span class="wiring-row-reason wiring-row-detail">${escapeHtml(detail)}</span>` : ""}
        ${test?.ran
          ? `<span class="wiring-row-reason wiring-row-test-${test.ok ? "ok" : "fail"}">${escapeHtml(
              test.ok ? `Verified by the app itself: ${test.message}` : `The app's own test failed: ${test.message}`
            )}</span>`
          : ""}
      </span>
    </li>
  `;
}

function renderWiringModal() {
  if (!ui.wiring?.open) {
    return "";
  }

  const report = ui.wiring.report;
  const verdict = WIRING_READINESS_META[report.readiness] || WIRING_READINESS_META.pending;

  const linkRows = report.links
    .map((link) =>
      renderWiringRow({
        title: `${link.sourceName} → ${link.targetName}`,
        subtitle: link.address?.baseUrl || null,
        state: link.state,
        reason: link.reason,
        // The address is the part that is easy to get wrong and impossible to
        // eyeball, so the reasoning behind it is shown rather than hidden.
        detail: link.addressReason,
        test: link.test
      })
    )
    .join("");

  const folderRows = report.rootFolders
    .map((folder) =>
      renderWiringRow({
        title: `${folder.name} library folder`,
        subtitle: folder.actual?.length ? folder.actual.map((entry) => entry.path).join(", ") : folder.expectedPath,
        state: folder.state,
        reason: folder.reason,
        detail: folder.derivedFrom ? `Derived from ${folder.derivedFrom}.` : null
      })
    )
    .join("");

  const mappingRows = report.pathMappings
    .map((mapping) =>
      renderWiringRow({
        title: `${mapping.name} download paths`,
        subtitle: mapping.mapping ? `${mapping.mapping.remotePath} → ${mapping.mapping.localPath}` : null,
        state: mapping.state,
        reason: mapping.reason
      })
    )
    .join("");

  const participantRows = report.participants
    .map((participant) => {
      const key = participant.apiKey;
      const note =
        key.state === "found"
          ? `API key read from ${key.source}`
          : key.state === "unsupported"
            ? "Keelarr does not need an API key for this app"
            : key.reason;

      // Tone follows how the app is actually watched, not whether Keelarr
      // personally reached it. A container reporting its own health is fine.
      const monitoring = participant.monitoring || { level: "probe", summary: "" };
      const tone = monitoring.level === "process" ? "warn" : "ok";
      const icon = monitoring.level === "probe"
        ? "fa-solid fa-satellite-dish"
        : monitoring.level === "healthcheck"
          ? "fa-solid fa-heart-pulse"
          : "fa-solid fa-circle-question";

      return `
        <li class="wiring-row wiring-row-${tone}">
          <span class="wiring-row-icon"><i class="${icon}"></i></span>
          <span class="wiring-row-body">
            <span class="wiring-row-title">
              ${escapeHtml(participant.name)}
              <span class="wiring-row-state">${escapeHtml(participant.topology.kind)}</span>
            </span>
            <span class="wiring-row-reason">${escapeHtml(monitoring.summary)}</span>
            <span class="wiring-row-reason wiring-row-detail">${escapeHtml(note)}</span>
          </span>
        </li>
      `;
    })
    .join("");

  return `
    <div class="modal-backdrop" data-modal-backdrop="wiring">
      <div class="path-picker-modal wiring-modal" role="dialog" aria-modal="true" aria-label="Stack wiring">
        <div class="path-picker-header">
          <div>
            <div class="path-picker-title">Stack wiring</div>
            <div class="path-picker-copy">How these apps are connected to each other</div>
          </div>
          <button type="button" class="toast-dismiss" data-wiring-close="true" aria-label="Close">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div class="wiring-verdict wiring-verdict-${verdict.tone}">
          <i class="${verdict.icon}"></i>
          <span>${escapeHtml(report.readinessMessage)}</span>
        </div>

        ${renderWiringPrerequisites(report)}
        ${renderWiringOrphans(report)}

        <div class="wiring-section-title">Connections</div>
        <ul class="wiring-list">${linkRows}</ul>

        <div class="wiring-section-title">Library folders</div>
        <ul class="wiring-list">${folderRows}</ul>

        ${mappingRows ? `<div class="wiring-section-title">Download paths</div><ul class="wiring-list">${mappingRows}</ul>` : ""}

        <div class="wiring-section-title">Apps</div>
        <ul class="wiring-list">${participantRows}</ul>

        <div class="removal-preserved">
          <i class="fa-solid fa-shield-halved"></i>
          <span>
            <strong>Nothing was changed.</strong>
            This is a read-only check. It reads each app's settings and asks the app to run its own connection
            tests, which is why a passing result means the app really can reach the other one, not just that the
            address looks right.
          </span>
        </div>

        ${renderWiringApply(report)}

        <div class="path-picker-actions" style="justify-content:flex-end;">
          <button type="button" class="button-default" data-wiring-close="true">Close</button>
          <button type="button" class="button-default" data-wiring-action="recheck">Check again</button>
          ${wiringActionable(report).length
            ? `<button type="button" class="button-primary" data-wiring-action="apply" ${ui.wiring.submitting ? "disabled" : ""}>
                 ${ui.wiring.submitting ? "Configuring..." : `Configure ${wiringActionable(report).length}`}
               </button>`
            : ""}
        </div>
      </div>
    </div>
  `;
}

/**
 * The things Keelarr cannot do for you, with a way to go and do them.
 *
 * These are credentials — an indexer key, a Usenet account, a Plex token — and
 * they are the reason a stack can be perfectly wired and still unable to find a
 * single release. Each row says what breaks without it and links straight to
 * the page that fixes it, using the address a browser can actually reach.
 */
function renderWiringPrerequisites(report) {
  const items = report.prerequisites || [];

  if (items.length === 0) {
    return "";
  }

  const rows = items
    .map((item) => `
      <li class="wiring-row wiring-row-warn">
        <span class="wiring-row-icon"><i class="fa-solid fa-key"></i></span>
        <span class="wiring-row-body">
          <span class="wiring-row-title">
            ${escapeHtml(item.name)}
            <span class="wiring-row-state">${escapeHtml(item.requirement.replace(/-/g, " "))}</span>
          </span>
          <span class="wiring-row-reason">${escapeHtml(item.summary)}</span>
          <span class="wiring-row-reason wiring-row-detail">${escapeHtml(item.consequence)}</span>
          ${item.link
            ? `<a class="wiring-row-link" href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer noopener">
                 Open ${escapeHtml(item.name)} settings <i class="fa-solid fa-arrow-up-right-from-square"></i>
               </a>`
            : ""}
        </span>
      </li>
    `)
    .join("");

  return `
    <div class="wiring-section-title">Needs you</div>
    <ul class="wiring-list">${rows}</ul>
    <div class="wiring-row-reason wiring-needs-you-note">
      Keelarr configures everything that is not a secret. These carry your own credentials, so it reports them
      rather than holding them.
    </div>
  `;
}

/**
 * Configuration in an app that points at a service this stack no longer has.
 *
 * Reported and never removed, exactly like drift: reaching into another app to
 * delete something Keelarr did not put there is not its call. Saying nothing,
 * though, leaves a connection that fails for a reason nobody can see.
 */
function renderWiringOrphans(report) {
  const items = report.orphans || [];

  if (items.length === 0) {
    return "";
  }

  const rows = items
    .map((item) => `
      <li class="wiring-row wiring-row-warn">
        <span class="wiring-row-icon"><i class="fa-solid fa-link-slash"></i></span>
        <span class="wiring-row-body">
          <span class="wiring-row-title">
            ${escapeHtml(item.serviceName)}
            <span class="wiring-row-state">leftover</span>
          </span>
          <span class="wiring-row-reason">${escapeHtml(item.summary)}</span>
          <span class="wiring-row-reason wiring-row-detail">${escapeHtml(item.consequence)}</span>
        </span>
      </li>
    `)
    .join("");

  return `
    <div class="wiring-section-title">Left over from a removed app</div>
    <ul class="wiring-list">${rows}</ul>
    <div class="wiring-row-reason wiring-needs-you-note">
      Removing an app cannot delete what another app was told about it. Keelarr reports these rather than editing
      configuration it did not create — remove them in the app itself.
    </div>
  `;
}

/**
 * Only genuinely missing connections are offered. Drift and ambiguity are shown
 * in the report above but never included here — Keelarr does not overwrite a
 * configuration someone made on purpose.
 */
function wiringActionable(report) {
  return [
    // Falls back to the link's own title rather than interpolating undefined:
    // a confirmation that reads "undefined → undefined" is worse than useless,
    // because it asks for approval while hiding what is being approved.
    ...report.links
      .filter((link) => link.state === "absent")
      .map((link) => (link.sourceName && link.targetName
        ? `${link.sourceName} → ${link.targetName}`
        : link.title || `${link.serviceId || "?"} → ${link.targetId || "?"}`)),
    ...report.rootFolders
      .filter((folder) => folder.state === "absent")
      .map((folder) => `${folder.name} library folder ${folder.expectedPath}`)
  ];
}

function renderWiringApply(report) {
  const items = wiringActionable(report);
  const held = [
    ...report.links.filter((link) => link.state === "drift" || link.state === "ambiguous"),
    ...report.rootFolders.filter((folder) => folder.state === "drift")
  ];

  if (!items.length && !held.length) {
    return "";
  }

  return `
    <div class="wiring-apply">
      ${items.length
        ? `<div class="wiring-section-title" style="margin-top:0;">Keelarr can configure</div>
           <ul class="removal-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
           <div class="wiring-row-reason">Each one is tested against the app before it is saved, so a connection that
           would not work is refused rather than written.</div>`
        : ""}
      ${held.length
        ? `<div class="wiring-section-title">Left alone</div>
           <ul class="removal-list">${held
             .map((entry) => `<li>${escapeHtml(entry.sourceName ? `${entry.sourceName} → ${entry.targetName}` : entry.name)} — ${escapeHtml(entry.reason)}</li>`)
             .join("")}</ul>
           <div class="wiring-row-reason">These already exist and point somewhere else. Change them in the app itself if
           that is not what you want.</div>`
        : ""}
    </div>
  `;
}

async function submitWiring() {
  ui.wiring.submitting = true;
  render();

  try {
    const data = await request("/api/wiring/apply", { method: "POST", body: JSON.stringify({}) });
    ui.wiring = null;
    ui.job = data.job;
    render();
    await pollJob(data.job.id);
  } catch (error) {
    ui.wiring.submitting = false;
    ui.wiring.error = error.message;
    render();
    throw error;
  }
}

function closeCutoverDialog() {
  ui.cutover = null;
  render();
}

function stopJobPolling() {
  if (ui.jobTimer) {
    clearTimeout(ui.jobTimer);
    ui.jobTimer = null;
  }
}

const DISMISSED_JOBS_KEY = "keelarr.dismissedJobs";
// A job that finished while the page was away is still worth showing: the
// operator needs the outcome of a destructive action they did not watch.
const REATTACH_RECENT_MS = 10 * 60 * 1000;

function isJobLive(job) {
  return job.status === "pending" || job.status === "running";
}

function readDismissedJobIds() {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(DISMISSED_JOBS_KEY)) || []);
  } catch {
    return new Set();
  }
}

function rememberDismissedJob(jobId) {
  try {
    const ids = readDismissedJobIds();
    ids.add(jobId);
    // Bound the list so it cannot grow without limit.
    window.localStorage.setItem(DISMISSED_JOBS_KEY, JSON.stringify([...ids].slice(-50)));
  } catch {
    // Storage being unavailable only costs us dismissal memory.
  }
}

/**
 * Reattaches the job panel after a page load so a refresh during a cutover
 * does not orphan it. Jobs live in the controller, not the page.
 */
async function reattachJob() {
  const data = await request("/api/jobs");
  const dismissed = readDismissedJobIds();
  const now = Date.now();
  const candidate = [...(data.jobs || [])]
    .reverse()
    .find((job) => {
      if (dismissed.has(job.id)) {
        return false;
      }

      // The update banner owns this one. Reattaching it would open a second
      // panel describing the same operation, whose reporter died with the
      // container it was reporting on.
      if (job.kind === "controller-update") {
        return false;
      }

      if (isJobLive(job)) {
        return true;
      }

      const finishedAt = job.finishedAt ? Date.parse(job.finishedAt) : NaN;
      return Number.isFinite(finishedAt) && now - finishedAt < REATTACH_RECENT_MS;
    });

  if (!candidate) {
    return;
  }

  ui.job = candidate;

  if (isJobLive(candidate)) {
    await pollJob(candidate.id);
    return;
  }

  render();
}

/**
 * Polls a running job until it reaches a terminal state, then refreshes the
 * dashboard so managed state and the revert button reflect the outcome.
 */
async function pollJob(jobId, failures = 0) {
  stopJobPolling();

  let data;
  try {
    data = await request(`/api/jobs/${jobId}`);
  } catch (error) {
    // A job runs on the host, not in this page. Discarding the panel on the
    // first failed poll threw away the only view of an operation that was
    // still going, and stopped polling for good — so a moment of network
    // trouble looked exactly like a failed cutover.
    if (failures + 1 >= JOB_POLL_MAX_FAILURES) {
      ui.jobStale = error.message || "No response.";
      ui.jobStaleFatal = true;
      render();
      return;
    }

    ui.jobStale = "Lost contact with Keelarr. Still trying.";
    ui.jobStaleFatal = false;
    render();
    ui.jobTimer = setTimeout(() => {
      pollJob(jobId, failures + 1).catch(showError);
    }, JOB_POLL_RETRY_MS);
    return;
  }

  ui.jobStale = null;
  ui.jobStaleFatal = false;
  ui.job = data.job;
  render();

  if (data.job.status === "pending" || data.job.status === "running") {
    ui.jobTimer = setTimeout(() => {
      pollJob(jobId).catch(showError);
    }, 1200);
    return;
  }

  await loadState();
  if (state.importScan) {
    await scanImports(true);
  }

  const label = jobKindLabel(data.job.kind);
  const unverified = data.job.result?.outcome === "unverified";

  showToast(
    data.job.status === "succeeded"
      ? unverified
        ? `${label} finished, but health was not confirmed.`
        : `${label} finished.`
      : `${label} failed. See the step list for details.`,
    data.job.status === "succeeded" && !unverified ? "success" : "danger"
  );
}

async function submitCutoverDialog() {
  const dialog = ui.cutover;

  if (!dialog || dialog.confirmText.trim() !== dialog.containerName) {
    return;
  }

  dialog.submitting = true;
  dialog.error = null;
  render();

  const url = dialog.mode === "rollback"
    ? `/api/services/${dialog.serviceId}/rollback`
    : dialog.mode === "revert"
      ? `/api/services/${dialog.serviceId}/revert-cutover`
      : `/api/import/${dialog.containerId}/cutover`;

  try {
    const data = await request(url, {
      method: "POST",
      body: JSON.stringify({
        confirmContainerName: dialog.containerName,
        restoreConfig: dialog.mode === "rollback" && dialog.restoreConfig === true
      })
    });

    ui.cutover = null;
    ui.job = data.job;
    render();
    await pollJob(data.job.id);
  } catch (error) {
    // Keep the dialog open so the reason stays attached to the action.
    if (ui.cutover) {
      ui.cutover.submitting = false;
      ui.cutover.error = error.message;
    }
    render();
  }
}

async function reviewServiceAdoption(containerId) {
  ui.view = "adoption";
  render();

  await scanImports(true);

  if (containerId) {
    await previewImport(containerId);
  }
}

async function serviceAction(serviceId, action) {
  ui.pendingServices.add(serviceId);
  render();

  try {
    const data = await request(`/api/services/${serviceId}/${action}`, {
      method: "POST"
    });
    setLatestResult(`${serviceId} ${action}`, data);
    await loadState();
    if (state.importScan) {
      await scanImports();
    }
  } finally {
    ui.pendingServices.delete(serviceId);
    render();
  }
}

async function deployAllSelected() {
  if (!state.configured) {
    ui.view = "settings";
    render();
    return;
  }

  const targets = selectedServices().filter((service) => !isServiceRunning(service));
  if (!targets.length) {
    setLatestResult("Deploy All", {
      ok: true,
      results: []
    });
    render();
    return;
  }

  const results = [];
  for (const service of targets) {
    ui.pendingServices.add(service.id);
    render();
    try {
      const result = await request(`/api/services/${service.id}/install`, {
        method: "POST"
      });
      results.push({
        serviceId: service.id,
        ok: result.ok,
        // The install connects the app afterwards as its own job. Following it
        // is what turns "deployed" into "deployed and working".
        wiringJob: result.wiringJob || null
      });
    } catch (error) {
      results.push({
        serviceId: service.id,
        ok: false,
        error: error.message
      });
    } finally {
      ui.pendingServices.delete(service.id);
      render();
    }
  }

  setLatestResult("Deploy All", {
    ok: results.every((item) => item.ok),
    results
  });
  await loadState();

  // Installing starts a wiring job that connects what was just deployed. Only
  // the last one matters: each re-plans the whole stack, so following the
  // newest covers everything installed in this run.
  const wiringJob = results.filter((item) => item.wiringJob).at(-1)?.wiringJob;

  if (wiringJob) {
    ui.job = wiringJob;
    render();
    await pollJob(wiringJob.id);
  }
}

async function checkAllUpdates() {
  const data = await request("/api/services/check-all", {
    method: "POST"
  });
  setLatestResult("Check All Updates", data);
  ui.view = "activity";
  ui.jsonOpen = true;
  await loadState();
}

async function upgradeAll() {
  const data = await request("/api/services/upgrade-all", {
    method: "POST"
  });
  setLatestResult("Upgrade All", data);

  // Nothing needed upgrading, so there is no job to follow. Say so rather than
  // opening an empty progress panel.
  if (!data.job) {
    showToast(data.message || "Everything is already up to date.", "info");
    render();
    return;
  }

  // Job-backed: show progress per service and poll rather than leaving the page
  // frozen for the length of the whole stack upgrade.
  ui.job = data.job;
  render();
  await pollJob(data.job.id);
}

function clearActivityView() {
  state.activity = [];
  ui.latestResult = null;
  render();
}

function showError(error) {
  setLatestResult("Error", {
    ok: false,
    error: error.message,
    details: error.details || error.payload?.details || null
  });
  // A failed action has to be as visible as a successful one. showToast
  // renders, so no separate render call is needed here.
  showToast(error.message || "Something went wrong.", "error");
}

appNode.addEventListener("submit", (event) => {
  if (!event.target.closest("[data-auth-form]")) {
    return;
  }

  event.preventDefault();
  submitAuth().catch(showError);
});

appNode.addEventListener("click", (event) => {
  if (event.target.closest("[data-auth-signout]")) {
    signOut().catch(showError);
    return;
  }

  if (event.target.closest("[data-result-dismiss]")) {
    ui.latestResult = null;
    render();
    return;
  }

  const navTarget = event.target.closest("[data-nav-view]");
  if (navTarget) {
    if (navTarget.dataset.navView !== ui.view) {
      // The panel describes what just happened on the screen you were on;
      // it should not follow you around the app.
      ui.latestResult = null;
    }
    ui.view = navTarget.dataset.navView;
    render();
    return;
  }

  const bannerTarget = event.target.closest("[data-banner-action]");
  if (bannerTarget) {
    const action = bannerTarget.dataset.bannerAction;
    if (action === "open-settings") {
      ui.view = "settings";
    }

    if (action === "dismiss-warning") {
      ui.warnOpen = false;
    }

    render();
    return;
  }

  const toolbarTarget = event.target.closest("[data-toolbar-action]");
  if (toolbarTarget) {
    const action = toolbarTarget.dataset.toolbarAction;

    // A second click mid-deploy would run the whole thing twice.
    if (ui.busy) {
      return;
    }

    (async () => {
      if (action === "refresh") {
        await loadState();
        return;
      }

      if (action === "deploy-all") {
        await runBusy("Deploying selected stacks...", deployAllSelected);
        return;
      }

      if (action === "check-updates") {
        await runBusy("Checking for updates...", checkAllUpdates);
        return;
      }

      if (action === "check-wiring") {
        await runBusy("Checking how the apps are connected...", () => openWiringDialog());
        return;
      }

      if (action === "upgrade-all") {
        await runBusy("Starting upgrade...", upgradeAll);
        return;
      }

      if (action === "options") {
        ui.view = "settings";
        render();
        return;
      }

      if (action === "scan-docker") {
        await runBusy("Scanning existing containers...", () => scanImports());
        return;
      }

      if (action === "preview-draft") {
        const targetId = ui.selectedImportContainerId || state.importScan?.items.find((item) => item.recognized)?.containerId;
        if (targetId) {
          await previewImport(targetId);
        }
        return;
      }

      if (action === "clear-activity") {
        clearActivityView();
        return;
      }

      if (action === "save") {
        await runBusy("Saving host settings...", saveSettingsOnly);
        return;
      }

      if (action === "detect-host") {
        await runBusy("Detecting host...", () => detectHost());
        return;
      }

      if (action === "toggle-advanced") {
        ui.advOpen = !ui.advOpen;
        render();
      }
    })().catch(showError);
    return;
  }

  const detectionTarget = event.target.closest("[data-detection-adapter]");
  if (detectionTarget) {
    detectHost(detectionTarget.dataset.detectionAdapter).catch(showError);
    return;
  }

  const browseTarget = event.target.closest("[data-browse-field]");
  if (browseTarget) {
    browseHostDirectories(browseTarget.dataset.browseField).catch(showError);
    return;
  }

  if (event.target.closest("[data-toast-dismiss]")) {
    closeToast();
    render();
    return;
  }

  // Backdrop dismissal matches only when the backdrop itself is the target.
  // Modal content must not stopPropagation: every click handler in this app is
  // delegated on #app, so a swallowed click disables the whole dialog.
  const backdropKind = event.target.dataset?.modalBackdrop;
  if (backdropKind === "path") {
    closePathPicker();
    return;
  }

  if (backdropKind === "cutover") {
    closeCutoverDialog();
    return;
  }

  if (backdropKind === "removal") {
    closeRemovalDialog();
    return;
  }

  if (backdropKind === "wiring" || event.target.closest("[data-wiring-close]")) {
    closeWiringDialog();
    return;
  }

  const wiringAction = event.target.closest("[data-wiring-action]");
  if (wiringAction) {
    if (wiringAction.dataset.wiringAction === "apply") {
      submitWiring().catch(showError);
    } else {
      runBusy("Checking how the apps are connected...", () => openWiringDialog()).catch(showError);
    }
    return;
  }

  if (event.target.closest("[data-removal-close]")) {
    closeRemovalDialog();
    return;
  }

  if (event.target.closest("[data-removal-action]")) {
    submitRemoval().catch(showError);
    return;
  }

  if (event.target.closest("[data-path-close]")) {
    closePathPicker();
    return;
  }

  const pathOpenTarget = event.target.closest("[data-path-open]");
  if (pathOpenTarget) {
    browseHostDirectories(ui.pathPicker?.fieldKey, pathOpenTarget.dataset.pathOpen).catch(showError);
    return;
  }

  if (event.target.closest("[data-path-use]")) {
    applyPathPickerSelection();
    return;
  }

  if (event.target.closest("[data-cutover-close]")) {
    closeCutoverDialog();
    return;
  }

  const cutoverActionTarget = event.target.closest("[data-cutover-action]");
  if (cutoverActionTarget) {
    submitCutoverDialog().catch(showError);
    return;
  }

  const controllerTarget = event.target.closest("[data-controller-action]");
  if (controllerTarget) {
    const action = controllerTarget.dataset.controllerAction;

    if (action === "check") {
      checkControllerUpdate().catch(showError);
    } else if (action === "open") {
      openControllerUpdateDialog();
    } else if (action === "close") {
      closeControllerUpdateDialog();
    } else if (action === "start") {
      startControllerUpdate().catch(showError);
    } else if (action === "retry-probe") {
      if (ui.controllerUpdate) {
        ui.controllerUpdate.phase = "waiting";
        render();
        watchControllerRestart();
      }
    } else if (action === "dismiss") {
      ui.controllerUpdate = null;
      forgetControllerUpdateWatch();
      request("/api/self-update/dismiss", { method: "POST" }).catch(() => {});
      render();
    }

    return;
  }

  const bootstrapTarget = event.target.closest("[data-bootstrap-action]");
  if (bootstrapTarget) {
    startSession().catch(showError);
    return;
  }

  const jobTarget = event.target.closest("[data-job-action]");
  if (jobTarget) {
    if (jobTarget.dataset.jobAction === "retry") {
      const jobId = ui.job?.id;
      ui.jobStale = null;
      ui.jobStaleFatal = false;
      render();
      if (jobId) {
        pollJob(jobId).catch(showError);
      }
      return;
    }

    stopJobPolling();
    if (ui.job) {
      // Remember the dismissal so a refresh does not resurrect the panel.
      rememberDismissedJob(ui.job.id);
    }
    ui.job = null;
    ui.jobStale = null;
    ui.jobStaleFatal = false;
    render();
    return;
  }

  const menuToggle = event.target.closest("[data-row-menu]");
  if (menuToggle) {
    const id = menuToggle.dataset.rowMenu;
    ui.rowMenu = ui.rowMenu === id ? null : id;
    render();
    return;
  }

  const menuAction = event.target.closest("[data-row-menu-action]");
  if (menuAction) {
    const action = menuAction.dataset.rowMenuAction;
    const serviceId = menuAction.dataset.serviceId;
    ui.rowMenu = null;
    render();

    const service = selectedServices().find((candidate) => candidate.id === serviceId);

    if (action === "remove") {
      runBusy("Checking what would be removed...", () => openRemovalDialog(serviceId)).catch(showError);
      return;
    }

    if (action === "rollback" && service) {
      openCutoverDialog({
        mode: "rollback",
        serviceId,
        serviceName: service.name,
        containerName: service.observedContainerName,
        rollbackImage: service.rollbackPoint?.taggedImage || service.rollbackPoint?.imageRef,
        hasConfigSnapshot: service.rollbackPoint?.hasConfigSnapshot === true,
        snapshotTakenAt: service.rollbackPoint?.backedUpAt || null
      });
      return;
    }

    if (action === "install" || action === "upgrade" || action === "restart") {
      const verb = { install: "Installing", upgrade: "Upgrading", restart: "Restarting" }[action];

      runBusy(`${verb} ${service?.name || serviceId}...`, () => serviceAction(serviceId, action)).catch(showError);
      return;
    }

    return;
  }

  // Any other click closes an open row menu.
  if (ui.rowMenu && !event.target.closest(".row-menu")) {
    ui.rowMenu = null;
    render();
  }

  const stackTarget = event.target.closest("[data-stack-action]");
  if (stackTarget) {
    const serviceId = stackTarget.dataset.serviceId;
    const containerId = stackTarget.dataset.containerId || null;
    const stackAction = stackTarget.dataset.stackAction;

    if (stackAction === "review-adoption") {
      reviewServiceAdoption(containerId).catch(showError);
      return;
    }

    if (stackAction === "remove") {
      runBusy("Checking what would be removed...", () => openRemovalDialog(serviceId)).catch(showError);
      return;
    }

    if (stackAction === "rollback") {
      const service = selectedServices().find((candidate) => candidate.id === serviceId);
      if (service) {
        openCutoverDialog({
          mode: "rollback",
          serviceId,
          serviceName: service.name,
          containerName: service.observedContainerName,
          rollbackImage: service.rollbackPoint?.taggedImage || service.rollbackPoint?.imageRef,
          hasConfigSnapshot: service.rollbackPoint?.hasConfigSnapshot === true,
          snapshotTakenAt: service.rollbackPoint?.backedUpAt || null
        });
      }
      return;
    }

    if (stackAction === "revert-cutover") {
      const service = selectedServices().find((candidate) => candidate.id === serviceId);
      if (service) {
        openCutoverDialog({
          mode: "revert",
          serviceId,
          serviceName: service.name,
          containerName: service.observedContainerName,
          rollbackContainerName: service.rollbackContainerName
        });
      }
      return;
    }

    const action = stackAction === "upgrade" ? "upgrade" : "install";
    runBusy(
      action === "upgrade" ? `Upgrading ${serviceId}...` : `Installing ${serviceId}...`,
      () => serviceAction(serviceId, action)
    ).catch(showError);
    return;
  }

  const importTarget = event.target.closest("[data-import-action]");
  if (importTarget) {
    const containerId = importTarget.dataset.containerId;
    previewImport(containerId).catch(showError);
    return;
  }

  const importRowTarget = event.target.closest("[data-import-row]");
  if (importRowTarget && !event.target.closest("[data-import-action]")) {
    previewImport(importRowTarget.dataset.importRow).catch(showError);
    return;
  }

  const previewTarget = event.target.closest("[data-preview-action]");
  if (previewTarget) {
    const containerId = previewTarget.dataset.containerId;

    if (ui.busy) {
      return;
    }

    if (previewTarget.dataset.previewAction === "cutover") {
      const preview = state.importPreview;
      openCutoverDialog({
        mode: "cutover",
        containerId,
        serviceId: preview?.target?.serviceId || null,
        serviceName: preview?.target?.serviceName || preview?.source?.containerName,
        containerName: preview?.source?.containerName
      });
      return;
    }

    runBusy("Generating managed draft...", () => adoptImportDraft(containerId)).catch(showError);
    return;
  }

  const manageTarget = event.target.closest("[data-manage-toggle]");
  if (manageTarget) {
    toggleSelectedService(manageTarget.dataset.manageToggle);
    return;
  }

  const settingsTarget = event.target.closest("[data-settings-action]");
  if (settingsTarget) {
    const action = settingsTarget.dataset.settingsAction;

    if (ui.busy) {
      return;
    }

    if (action === "save") {
      runBusy("Saving host settings...", saveSettingsOnly).catch(showError);
      return;
    }

    if (action === "save-deploy") {
      // The slowest action in the app: it pulls images and starts containers.
      runBusy("Saving and deploying stacks. This can take a few minutes...", () => submitSetup(true)).catch(showError);
      return;
    }

    if (action === "save-generate") {
      runBusy("Saving and generating stack files...", () => submitSetup(false)).catch(showError);
      return;
    }
  }

  if (event.target.closest("[data-json-toggle]")) {
    ui.jsonOpen = !ui.jsonOpen;
    render();
    return;
  }

  if (event.target.closest("[data-app-link]")) {
    event.preventDefault();
  }
});

appNode.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  // Kept out of state.settings, and out of any re-render: retyping a password
  // because the field lost focus is its own small punishment.
  if (target.name === "authPassword") {
    ui.authPassword = target.value;
    return;
  }

  if (target.name === "authConfirm") {
    ui.authConfirm = target.value;
    return;
  }

  if (target.dataset.removalOption && ui.removal) {
    ui.removal[target.dataset.removalOption] = target.checked;
    render();
    return;
  }

  if (target.dataset.removalInput && ui.removal) {
    ui.removal.confirmText = target.value;
    render();
    return;
  }

  if (target.dataset.cutoverRestoreConfig && ui.cutover) {
    ui.cutover.restoreConfig = target.checked;
    render();
    return;
  }

  if (target.dataset.cutoverInput && ui.cutover) {
    ui.cutover.confirmText = target.value;
    // Re-render so the confirm button enables the moment the name matches.
    render();
    return;
  }

  if (!target.name) {
    return;
  }

  state.settings = {
    ...state.settings,
    [target.name]: target.value
  };
});

appNode.addEventListener("change", (event) => {
  const target = event.target;

  if (target.name === "authPassword" || target.name === "authConfirm") {
    return;
  }

  // Selects fire `change` rather than `input`, so they are handled here too.
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) {
    return;
  }

  if (!target.name) {
    return;
  }

  updateSettingValue(target.name, target.value);
});

appNode.addEventListener("keydown", (event) => {
  const authForm = event.target.closest?.("[data-auth-form]");

  // Enter in a password field submits. Handled explicitly rather than left to
  // the browser's implicit submission, and the default is suppressed so the
  // form is submitted exactly once either way.
  if (authForm && event.key === "Enter") {
    event.preventDefault();
    authForm.requestSubmit();
    return;
  }

  if (!ui.cutover?.open) {
    return;
  }

  if (event.key === "Escape") {
    closeCutoverDialog();
    return;
  }

  if (event.key === "Enter" && event.target.dataset?.cutoverInput) {
    event.preventDefault();
    submitCutoverDialog().catch(showError);
  }
});

/**
 * Opens a session and loads the dashboard, recording why it could not rather
 * than raising into a page with nowhere to put the message. Safe to call again
 * from the retry button.
 */
function bootstrap() {
  const watch = readControllerUpdateWatch();

  // Resumed before anything that can reject: this page may have been reloaded
  // into the outage the update created, and the record is the only thing that
  // knows an update is the reason nothing is answering.
  if (watch) {
    ui.controllerUpdate = { ...watch, phase: "waiting", dialogOpen: false, attempts: 0 };
    render();
    watchControllerRestart();
    return;
  }

  startSession();
}

async function startSession() {
  ui.bootstrapError = null;

  try {
    const auth = await loadAuth();

    if (auth.required && !auth.authenticated) {
      render();
      return;
    }

    await loadState();
    // A failed reattach must not block the dashboard from rendering.
    await reattachJob().catch((error) => console.warn("Job reattach failed.", error));
  } catch (error) {
    ui.bootstrapError = error.message || "No response.";
    render();
  }
}

bootstrap();
