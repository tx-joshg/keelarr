import { SERVICE_ORDER, getServiceDefinition } from "./service-catalog.js";
import { detectMediaServers, evaluateCompatibility } from "./compatibility.js";

/**
 * What the app picker renders, derived from a settings object and one scan.
 *
 * A pure function over those two inputs, which is what lets live mode and demo
 * mode share it: the only difference between them is where the scan came from,
 * and that difference should not reach the shape of the view.
 */
export function buildWizardView({ settings, inventory }) {
  const items = Array.isArray(inventory?.items) ? inventory.items : [];
  const selected = settings?.selectedServiceIds || [];

  // Containers Keelarr recognised, keyed by the app they are. First match wins:
  // two containers of the same app is something the adoption screen explains,
  // not something the picker should silently choose between.
  const running = new Map();

  for (const item of items) {
    if (item.recognized && item.serviceId && !running.has(item.serviceId)) {
      running.set(item.serviceId, item);
    }
  }

  // An app the picker would adopt keeps the port its container already
  // publishes — adoption saves exactly that. Judging it on the catalog default
  // instead would let a real collision through: a Sonarr published on 7878
  // looks like 8989 here, so a new default Radarr would appear to fit.
  const publishedPort = (item) => {
    const port = Number((item?.ports || []).find((entry) => entry?.hostPort)?.hostPort);
    return Number.isInteger(port) && port > 0 ? port : null;
  };
  const effectiveOverrides = { ...(settings?.serviceOverrides || {}) };

  for (const [id, item] of running) {
    const port = selected.includes(id) ? null : publishedPort(item);

    if (port) {
      effectiveOverrides[id] = { ...(effectiveOverrides[id] || {}), port };
    }
  }

  const catalog = SERVICE_ORDER.map((id) => {
    const definition = getServiceDefinition(id);
    const existing = running.get(id) || null;
    const managed = selected.includes(id);

    return {
      id,
      name: definition.name,
      family: definition.family,
      description: definition.description,
      defaultPort: definition.defaultPort,
      port: Number(effectiveOverrides[id]?.port || definition.defaultPort),
      selected: managed,
      // What ticking this box will actually do, which is the whole point of the
      // picker: "install this" and "take over the one you already run" are very
      // different promises, and the operator should know which they are making.
      action: existing ? (managed ? "managed" : "adopt") : "install",
      existing: existing
        ? {
            // The scan calls this `containerId`; keep that name so the picker can
            // hand it straight to the adoption endpoints.
            containerId: existing.containerId || existing.id || null,
            containerName: existing.name || null,
            image: existing.image || null,
            status: existing.status || null,
            // Adoption is read-only first and is allowed to refuse. Saying so
            // here stops the picker promising an adoption the next screen declines.
            adoptable: existing.adoptable === true,
            issues: (existing.issues || []).filter((issue) => issue.level !== "info")
          }
        : null
    };
  });

  return {
    catalog,
    selectedServiceIds: selected,
    initialized: settings?.initialized === true,
    scannedAt: inventory?.scannedAt || null,
    // Apps running on this host that Keelarr has no catalog entry for. Needed
    // because a Plex nobody manages still decides whether Tautulli makes sense.
    mediaServers: detectMediaServers(items),
    unrecognized: items
      .filter((item) => !item.recognized)
      .map((item) => ({ name: item.name, image: item.image })),
    compatibility: evaluateCompatibility({
      selectedServiceIds: selected,
      serviceOverrides: effectiveOverrides,
      discovered: items
    })
  };
}
