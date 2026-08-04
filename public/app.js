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
  selectedImportContainerId: null,
  pendingServices: new Set()
};

const appNode = document.querySelector("#app");

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
  const hostUrl = stripTrailingSlash(state.settings?.hostUrl || "http://localhost");
  const port = live?.port ?? catalog.defaultPort;
  const appUrl = live?.appUrl ?? `${hostUrl}:${port}`;

  return {
    id,
    name: live?.name ?? catalog.name,
    description: live?.description ?? catalog.description,
    family: live?.family ?? catalog.family,
    port,
    appUrl,
    generated: live?.generated === true,
    runtimeStatus: live?.runtimeStatus || "not-deployed",
    reachable: live?.reachable === true,
    httpStatus: live?.httpStatus ?? null,
    latencyMs: live?.latencyMs ?? null,
    updateStatus: live?.updateStatus || "unknown",
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

  if (Array.isArray(latest.generated)) {
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
        ? '<span class="status-pill status-pill-success">Generated</span>'
        : '<span class="status-pill status-pill-idle">Missing</span>';
      const runtimeLabel = running
        ? '<span class="status-pill status-pill-success">Running</span>'
        : '<span class="status-pill status-pill-disabled">Not deployed</span>';
      const health = running
        ? `${service.httpStatus ?? 200} &middot; ${service.latencyMs ?? 34} ms`
        : "n/a";
      const primaryAction = running ? "upgrade" : "deploy";
      const primaryIcon = running ? "fa-solid fa-circle-up" : "fa-solid fa-cloud-arrow-up";
      const primaryColor = running ? "var(--primary-color)" : "var(--success-background)";

      return `
        <tr>
          <td class="status-cell">${statusIcon}</td>
          <td class="cell-truncate"><a href="#" data-app-link="${escapeHtml(service.id)}">${escapeHtml(service.name)}</a></td>
          <td class="cell-truncate role-copy">${escapeHtml(service.description)}</td>
          <td>${escapeHtml(String(service.port))}</td>
          <td>${composeLabel}</td>
          <td>${runtimeLabel}</td>
          <td class="cell-truncate health-copy">${health}</td>
          <td class="row-actions">
            <button
              type="button"
              class="row-icon-button"
              data-stack-action="${escapeHtml(primaryAction)}"
              data-service-id="${escapeHtml(service.id)}"
              style="color:${primaryColor};"
              title="${running ? "Upgrade" : "Deploy"}"
              ${pending ? "disabled" : ""}
            >
              <i class="${escapeHtml(primaryIcon)}"></i>
            </button>
            <a
              class="row-icon-link"
              href="${escapeHtml(service.appUrl)}"
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
  const summary = runningCount === 0
    ? `${escapeHtml(String(services.length))} apps selected, none deployed. Deploy writes each Compose file and starts the container.`
    : `${escapeHtml(String(runningCount))} of ${escapeHtml(String(services.length))} running &middot; 0 updates pending`;

  return `
    <div data-screen-label="Stack">
      <table class="table-view">
        <thead>
          <tr>
            <th style="width:4%;"></th>
            <th style="width:14%;">App</th>
            <th style="width:30%;">Role</th>
            <th style="width:8%;">Port</th>
            <th style="width:13%;">Compose</th>
            <th style="width:14%;">Runtime</th>
            <th style="width:11%;">Health</th>
            <th style="width:6%;"></th>
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

  return `
    <div class="form-row">
      <label class="${labelClass}" for="${escapeHtml(field.key)}">${escapeHtml(field.label)}</label>
      <div class="form-input-wrap">
        <input
          id="${escapeHtml(field.key)}"
          class="${inputClass}"
          type="text"
          name="${escapeHtml(field.key)}"
          value="${escapeHtml(value)}"
          placeholder="${escapeHtml(field.placeholder || "")}"
          autocomplete="off"
        >
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
      <div class="inspection-card ${item.adapterId === selected.adapterId ? "inspection-card-selected" : ""}">
        <div class="inspection-card-header">
          <strong>${escapeHtml(item.label)}</strong>
          ${renderStatusPill(item.confidence || "low", item.confidence === "high" ? "info" : item.confidence === "medium" ? "warn" : "manual")}
        </div>
        <div class="inspection-card-copy">score ${escapeHtml(String(item.score || 0))} &middot; ${item.matched ? "matched" : "fallback"}</div>
        <div class="inspection-card-copy">${escapeHtml((item.notes || []).join(" "))}</div>
      </div>
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
      key: "stackRoot",
      label: "Compose Stack Root",
      help: "Suggested from host detection. Does not exist yet and will be created."
    },
    {
      key: "mediaRoot",
      label: "Media Root",
      help: "Confirm this before deploying - every app mounts it."
    },
    {
      key: "plexLogsRoot",
      label: "Plex Logs Path",
      help: "Required while Tautulli is enabled.",
      placeholder: "/var/lib/plex/logs"
    },
    {
      key: "tz",
      label: "Timezone",
      help: "Applied to every generated container."
    }
  ];

  const advancedFields = [
    {
      key: "dockerBin",
      label: "Docker Binary",
      help: "Detected and validated on this host.",
      advanced: true
    },
    {
      key: "configRoot",
      label: "Config Root",
      help: "One subdirectory per app.",
      advanced: true
    },
    {
      key: "downloadsRoot",
      label: "Downloads Root",
      help: "Derived from Media Root.",
      advanced: true
    },
    {
      key: "puid",
      label: "PUID",
      help: "",
      advanced: true
    },
    {
      key: "pgid",
      label: "PGID",
      help: "",
      advanced: true
    },
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

  return `
    <div data-screen-label="Settings" class="form-container">
      ${renderFirstRunGuide()}
      ${renderHostInspection()}
      <fieldset class="fieldset">
        <legend class="legend">Host</legend>
        ${hostFields.map((field) => renderInputRow(field)).join("")}
      </fieldset>
      ${ui.advOpen
        ? `
          <fieldset class="fieldset">
            <legend class="legend legend-secondary">Paths and identity</legend>
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
        <button type="button" class="button-success" data-settings-action="save-deploy">Save And Deploy</button>
        <button type="button" class="button-default" data-settings-action="save-generate">Save And Generate</button>
        <span class="action-hint">${escapeHtml(visibleWarningCount() > 0 ? "1 warning to clear first" : "Ready to deploy")}</span>
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
    <span>Stackarr 0.4.2 &middot; compose-native ARR control plane</span>
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

  appNode.innerHTML = `
    <div class="app-shell">
      <header class="app-header">
        <div class="brand-slot">
          <div class="brand-mark">SA</div>
          <span class="brand-wordmark">Stackarr</span>
        </div>
        <div class="header-search">
          <label class="search-shell" aria-label="Search apps">
            <i class="fa-solid fa-magnifying-glass"></i>
            <input class="search-input" type="text" placeholder="Search apps" readonly tabindex="-1">
          </label>
        </div>
        <div class="header-icons">
          <button type="button" class="header-icon header-icon-warning" aria-label="Warnings"><i class="fa-solid fa-triangle-exclamation"></i></button>
          <button type="button" class="header-icon header-icon-donate" aria-label="Donate"><i class="fa-solid fa-heart"></i></button>
          <button type="button" class="header-icon header-icon-account" aria-label="Account"><i class="fa-solid fa-user"></i></button>
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
    </div>
  `;
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
  render();
}

function settingsPayload(deploy = false) {
  return {
    projectName: state.settings.projectName,
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
    body: JSON.stringify(settingsPayload(deploy))
  });
  setLatestResult(deploy ? "Save And Deploy" : "Save And Generate", data);
  ui.view = "stack";
  await loadState();
}

async function detectHost() {
  const data = await request("/api/host/detect", {
    method: "POST",
    body: JSON.stringify(settingsPayload(false))
  });
  state.hostDetection = data;
  state.settings = data.effectiveSettings || {
    ...state.settings,
    ...(data.selected?.suggestedSettings || {})
  };
  setLatestResult("Host Detection", data);
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
        await submitSetup(false);
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

  const stackTarget = event.target.closest("[data-stack-action]");
  if (stackTarget) {
    const serviceId = stackTarget.dataset.serviceId;
    const action = stackTarget.dataset.stackAction === "upgrade" ? "upgrade" : "install";
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
