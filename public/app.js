const appOrder = [
  "prowlarr",
  "radarr",
  "sonarr",
  "bazarr",
  "trailarr",
  "ombi",
  "tautulli",
  "sabnzbd",
  "lidarr",
  "readarr"
];

const state = {
  configured: false,
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
  selectedImportContainerId: null,
  pendingServices: new Set()
};

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
  return state.meta?.appName || "Stackarr";
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
    reachable: live?.reachable === true,
    healthStatus: live?.healthStatus || "unknown",
    httpStatus: live?.httpStatus ?? null,
    latencyMs: live?.latencyMs ?? null,
    updateStatus: live?.updateStatus || "unknown",
    updateCheckedAt: live?.updateCheckedAt || null,
    observedImage: live?.observedImage || live?.image || catalog.defaultImage,
    observedImageId: live?.observedImageId || null,
    observedContainerId: live?.observedContainerId || null,
    observedContainerName: live?.observedContainerName || live?.containerName || id,
    observedNetworkMode: live?.observedNetworkMode || live?.networkMode || "default",
    resourceUsage: live?.resourceUsage || null,
    publishings: Array.isArray(live?.publishings) ? live.publishings : [],
    networks: Array.isArray(live?.networks) ? live.networks : [],
    lastError: live?.lastError || null
  };
}

function selectedServices() {
  return selectedServiceIds()
    .map((id) => buildRenderService(id))
    .filter(Boolean);
}

function selectedCatalogEntries() {
  const selected = new Set(selectedServiceIds());
  return appOrder
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
      return { label: "Managed", tone: "info", detail: "Running under Stackarr Compose." };
    case "draft":
      return { label: "Draft", tone: "warn", detail: "Managed draft exists, but cutover is still pending." };
    case "detected":
      return { label: "Detected", tone: "manual", detail: "Live container found outside Stackarr management." };
    case "generated":
      return { label: "Generated", tone: "manual", detail: "Compose files exist, but the service is not running under Stackarr." };
    default:
      return { label: "Catalog", tone: "manual", detail: "Selected in catalog only." };
  }
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

function resolveServiceOpenUrl(service) {
  const qnetAddress = service.networks.find((network) => network.address)?.address || null;
  if (service.observedNetworkMode?.startsWith("qnet-static") && qnetAddress) {
    return `http://${qnetAddress}:${service.port}`;
  }

  const publishedHostPort = service.publishings.find((entry) => entry.hostPort)?.hostPort || null;
  const base = resolveUiHostBase();
  const openPort = publishedHostPort || service.port;

  return `${base.protocol}//${base.hostname}:${openPort}`;
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

function showToast(message, tone = "info") {
  ui.toast = {
    message,
    tone
  };

  if (ui.toastTimer) {
    window.clearTimeout(ui.toastTimer);
  }

  ui.toastTimer = window.setTimeout(() => {
    ui.toast = null;
    ui.toastTimer = null;
    render();
  }, 3200);
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

  return `
    <div class="result-panel ${latest.ok === false ? "result-panel-danger" : "result-panel-info"}">
      <div class="result-panel-header">
        <div>
          <div class="result-panel-title">${escapeHtml(ui.latestResult.title)}</div>
          ${summary ? `<div class="result-panel-copy">${escapeHtml(summary)}</div>` : ""}
        </div>
        ${renderStatusPill(latest.ok === false ? "Needs Attention" : "Ready", latest.ok === false ? "error" : "info")}
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

  return `
    <div class="toast-shell">
      <div class="toast-panel ${ui.toast.tone === "error" ? "toast-panel-danger" : "toast-panel-info"}">
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
    return [
      { action: "refresh", icon: "fa-solid fa-rotate", label: "Refresh" },
      { action: "deploy-all", icon: "fa-solid fa-cloud-arrow-up", label: "Deploy All" },
      { action: "check-updates", icon: "fa-solid fa-magnifying-glass-chart", label: "Check Updates" },
      { action: "upgrade-all", icon: "fa-solid fa-arrow-up-right-dots", label: "Upgrade All" },
      { action: "options", icon: "fa-solid fa-sliders", label: "Options" }
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
    ? `
      <div class="view-toggle">
        <button type="button" class="view-toggle-button view-toggle-button-active" aria-label="Table view">
          <i class="fa-solid fa-table-list"></i>
        </button>
        <button type="button" class="view-toggle-button" aria-label="Poster view">
          <i class="fa-solid fa-table-cells-large"></i>
        </button>
      </div>
    `
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

function renderStackView() {
  const services = selectedServices();

  if (!services.length) {
    return '<div class="empty-copy">No services are selected yet. Open Settings to choose the apps Stackarr should manage.</div>';
  }

  const rows = services
    .map((service) => {
      const running = isServiceRunning(service);
      const pending = ui.pendingServices.has(service.id);
      const statusIcon = pending
        ? '<i class="fa-solid fa-spinner fa-spin secondary-copy"></i>'
        : running
          ? '<i class="fa-solid fa-circle-check status-icon-good"></i>'
          : '<i class="fa-solid fa-circle-minus status-icon-idle"></i>';
      const composeLabel = service.generated
        ? renderStatusPill("Generated", "info")
        : renderStatusPill("Missing", "manual");
      const runtimeMeta = runtimeStatusMeta(service);
      const runtimeLabel = renderStatusPill(runtimeMeta.label, runtimeMeta.tone);
      const healthMeta = healthStatusMeta(service);
      const healthLabel = renderStatusPill(healthMeta.label, healthMeta.tone);
      const updateMeta = updateStatusMeta(service);
      const updateLabel = renderStatusPill(updateMeta.label, updateMeta.tone);
      const managementMeta = managementStateMeta(service);
      const versionTag = imageTagFromRef(service.observedImage);
      const imageIdTag = shortImageId(service.observedImageId);
      const versionDetail = imageIdTag
        ? `ref ${versionTag} · image ${imageIdTag} · ${managementMeta.detail}`
        : `${versionTag} · ${managementMeta.detail}`;
      const usageMarkup = renderUsageMetrics(service);
      const openUrl = resolveServiceOpenUrl(service);
      let primaryAction = "deploy";
      let primaryTitle = "Deploy";
      let primaryIcon = "fa-solid fa-cloud-arrow-up";
      let primaryColor = "var(--success-background)";
      let primaryContainerId = "";

      if (service.managementState === "managed") {
        primaryAction = running ? "upgrade" : "deploy";
        primaryTitle = running ? "Upgrade" : "Deploy";
        primaryIcon = running ? "fa-solid fa-circle-up" : "fa-solid fa-cloud-arrow-up";
        primaryColor = running ? "var(--primary-color)" : "var(--success-background)";
      } else if (service.managementState === "draft" || service.managementState === "detected") {
        primaryAction = "review-adoption";
        primaryTitle = "Review Adoption";
        primaryIcon = "fa-solid fa-file-import";
        primaryColor = "var(--warning-background)";
        primaryContainerId = service.observedContainerId || "";
      }

      return `
        <tr>
          <td class="status-cell">${statusIcon}</td>
          <td class="cell-truncate">
            <a href="#" data-app-link="${escapeHtml(service.id)}">${escapeHtml(service.name)}</a>
            <div class="secondary-copy">${escapeHtml(service.observedContainerName)}</div>
          </td>
          <td class="cell-truncate">
            <div>${escapeHtml(service.observedImage)}</div>
            <div class="secondary-copy">${escapeHtml(versionDetail)}</div>
          </td>
          <td>${escapeHtml(String(service.port))}</td>
          <td>${composeLabel}</td>
          <td>${runtimeLabel}</td>
          <td>${usageMarkup}</td>
          <td class="cell-truncate">
            ${healthLabel}
            <div class="secondary-copy">${service.httpStatus ? `${escapeHtml(String(service.httpStatus))}${service.latencyMs ? ` · ${escapeHtml(String(service.latencyMs))} ms` : ""}` : escapeHtml(managementMeta.label)}</div>
          </td>
          <td class="cell-truncate">${updateLabel}</td>
          <td class="row-actions">
            <button
              type="button"
              class="row-icon-button"
              data-stack-action="${escapeHtml(primaryAction)}"
              data-service-id="${escapeHtml(service.id)}"
              data-container-id="${escapeHtml(primaryContainerId)}"
              style="color:${primaryColor};"
              title="${escapeHtml(primaryTitle)}"
              ${pending ? "disabled" : ""}
            >
              <i class="${escapeHtml(primaryIcon)}"></i>
            </button>
            <a
              class="row-icon-link"
              href="${escapeHtml(openUrl)}"
              target="_blank"
              rel="noreferrer noopener"
              title="Open app"
            >
              <i class="fa-solid fa-arrow-up-right-from-square"></i>
            </a>
          </td>
        </tr>
      `;
    })
    .join("");

  const runningCount = services.filter((service) => isServiceRunning(service)).length;
  const updateReadyCount = services.filter((service) => service.updateStatus === "ready").length;
  const summary = runningCount === 0
    ? `${escapeHtml(String(services.length))} apps selected, none currently running under Stackarr monitoring.`
    : `${escapeHtml(String(runningCount))} of ${escapeHtml(String(services.length))} live ${updateReadyCount > 0 ? `· ${escapeHtml(String(updateReadyCount))} update${updateReadyCount === 1 ? "" : "s"} ready` : "· no managed updates pending"}`;

  return `
    <div data-screen-label="Stack">
      <table class="table-view">
        <thead>
          <tr>
            <th style="width:4%;"></th>
            <th style="width:14%;">App</th>
            <th style="width:28%;">Image / Source</th>
            <th style="width:8%;">Port</th>
            <th style="width:10%;">Compose</th>
            <th style="width:10%;">Runtime</th>
            <th style="width:14%;">Usage</th>
            <th style="width:12%;">Health</th>
            <th style="width:8%;">Update</th>
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
      <div class="muted-paragraph">Stackarr never writes during a scan. Recognized containers appear here with the managed Compose draft it would generate, so you can compare before any cutover.</div>
    `;
  }

  if (!state.importScan.items.length) {
    return `
      <div class="info-alert">
        <i class="fa-solid fa-circle-info"></i>
        <span>Read-only scan found no unmanaged containers.</span>
      </div>
      <div class="muted-paragraph">Stackarr never writes during a scan. Recognized containers appear here with the managed Compose draft it would generate, so you can compare before any cutover.</div>
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
        <div style="margin-top:14px;">${warnings || '<div class="preview-copy">This container is outside the current Stackarr scope.</div>'}</div>
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

  return `
    <div class="preview-card">
      <div class="preview-toolbar">
        <h3 class="preview-title">${escapeHtml(preview.source.containerName)} -> ${escapeHtml(preview.target.serviceName)}</h3>
        ${preview.adoptable
          ? `
            <button
              type="button"
              class="button-success"
              data-preview-action="adopt-draft"
              data-container-id="${escapeHtml(preview.source.containerId)}"
            >
              Generate Managed Draft
            </button>
          `
          : ""}
      </div>
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

function renderInputRow(field) {
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

  return `
    <button type="button" class="manage-row" data-manage-toggle="${escapeHtml(service.id)}">
      <span class="manage-row-label">${escapeHtml(service.name)}</span>
      <span class="manage-row-body">
        <span class="manage-box ${checked ? "manage-box-checked" : ""}">${checked ? "&#10003;" : ""}</span>
        <span class="manage-description">${escapeHtml(service.description)}</span>
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

  const manageRows = appOrder
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
        <div class="manage-intro">${escapeHtml(`${selectedServiceIds().length} of ${state.catalog.length || 10} services selected. Stackarr generates and operates only what is checked.`)}</div>
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
    <div class="modal-backdrop" data-path-close="true">
      <div class="path-picker-modal" role="dialog" aria-modal="true" aria-label="Browse host directories" onclick="event.stopPropagation()">
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

function renderFooter() {
  const services = selectedServices();
  const running = services.filter((service) => isServiceRunning(service)).length;
  const warnings = visibleWarningCount() > 0 ? "1 warning" : "no warnings";

  return `
    <span>${escapeHtml(String(services.length))} apps &middot; ${escapeHtml(String(running))} running &middot; ${escapeHtml(warnings)} &middot; PUID ${escapeHtml(state.settings?.puid || "1000")} / PGID ${escapeHtml(state.settings?.pgid || "1000")}</span>
    <span>${escapeHtml(appDisplayName())} ${escapeHtml(appVersion())} &middot; compose-native ARR control plane</span>
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

function render() {
  if (!state.settings) {
    appNode.innerHTML = '<div class="app-shell"><div class="page-content">Loading...</div></div>';
    return;
  }

  try {
    document.title = `${appDisplayName()} v${appVersion()}`;

    appNode.innerHTML = `
      <div class="app-shell">
        <header class="app-header">
          <div class="brand-slot">
            <div class="brand-mark">SA</div>
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
            <span class="header-icon header-icon-donate" aria-hidden="true"><i class="fa-solid fa-heart"></i></span>
            <span class="header-icon header-icon-account" aria-hidden="true"><i class="fa-solid fa-user"></i></span>
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
            ${renderResultPanel()}
            ${renderCurrentView()}
          </div>
          <div class="page-footer">${renderFooter()}</div>
            </div>
          </main>
        </div>
        ${renderToast()}
        ${renderPathPicker()}
      </div>
    `;
    window.__stackarrRenderError = null;
  } catch (error) {
    window.__stackarrRenderError = error?.message || "Render failed.";
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
    selectedServiceIds: appOrder.filter((id) => selected.has(id))
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
    selectedServiceIds: selectedServiceIds(),
    ...(preferredAdapterId ? { preferredAdapterId } : {}),
    deploy
  };
}

async function loadState() {
  const data = await request("/api/state");
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
  showToast(deploy ? "Settings saved and selected stacks deployed." : "Settings saved and stack files generated.");
  await loadState();
}

async function saveSettingsOnly() {
  const data = await request("/api/settings", {
    method: "POST",
    body: JSON.stringify(settingsPayload())
  });
  setLatestResult("Settings Saved", data);
  ui.view = "settings";
  showToast("Settings saved.");
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
        ok: result.ok
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
  await loadState();
}

function clearActivityView() {
  state.activity = [];
  ui.latestResult = null;
  render();
}

function showError(error) {
  closeToast();
  setLatestResult("Error", {
    ok: false,
    error: error.message,
    details: error.details || error.payload?.details || null
  });
  render();
}

appNode.addEventListener("click", (event) => {
  const navTarget = event.target.closest("[data-nav-view]");
  if (navTarget) {
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
    (async () => {
      if (action === "refresh") {
        await loadState();
        return;
      }

      if (action === "deploy-all") {
        await deployAllSelected();
        return;
      }

      if (action === "check-updates") {
        await checkAllUpdates();
        return;
      }

      if (action === "upgrade-all") {
        await upgradeAll();
        return;
      }

      if (action === "options") {
        ui.view = "settings";
        render();
        return;
      }

      if (action === "scan-docker") {
        await scanImports();
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
        await saveSettingsOnly();
        return;
      }

      if (action === "detect-host") {
        await detectHost();
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

  const stackTarget = event.target.closest("[data-stack-action]");
  if (stackTarget) {
    const serviceId = stackTarget.dataset.serviceId;
    const containerId = stackTarget.dataset.containerId || null;
    const stackAction = stackTarget.dataset.stackAction;

    if (stackAction === "review-adoption") {
      reviewServiceAdoption(containerId).catch(showError);
      return;
    }

    const action = stackAction === "upgrade" ? "upgrade" : "install";
    serviceAction(serviceId, action).catch(showError);
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
    adoptImportDraft(previewTarget.dataset.containerId).catch(showError);
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
    if (action === "save") {
      saveSettingsOnly().catch(showError);
      return;
    }

    if (action === "save-deploy") {
      submitSetup(true).catch(showError);
      return;
    }

    if (action === "save-generate") {
      submitSetup(false).catch(showError);
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
  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  if (!target.name) {
    return;
  }

  updateSettingValue(target.name, target.value);
});

loadState().catch(showError);
