export const RECONCILE_STATE = Object.freeze({
  /** Something already there matches what we would configure. */
  CORRECT: "correct",
  /** Exactly one comparable entry exists, pointing somewhere else. */
  DRIFT: "drift",
  /** Several comparable entries exist and none match. Never written to. */
  AMBIGUOUS: "ambiguous",
  /** Nothing comparable exists. */
  ABSENT: "absent"
});

export function fieldValue(entity, name) {
  return (entity?.fields || []).find((field) => field.name === name)?.value ?? null;
}

function normalizeUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * The shared shape behind every resource type.
 *
 * `candidates` are the entries comparable to what we want — same kind of thing,
 * regardless of where they point. `matches` decides whether one of them *is*
 * what we want. The gap between those two is where drift lives.
 *
 * Identity is never the entry's name. Names are the one field users freely
 * change: the download client on this stack is called "SABnzbd" purely by
 * convention, and matching on that would call a renamed client absent and
 * create a duplicate beside it.
 */
function reconcile({ candidates, matches, describeChanges, describe }) {
  const matched = candidates.find(matches);

  if (matched) {
    return {
      state: RECONCILE_STATE.CORRECT,
      target: matched,
      changes: [],
      reason: `${describe} is already configured correctly.`
    };
  }

  if (candidates.length === 1) {
    const changes = describeChanges(candidates[0]);

    return {
      state: RECONCILE_STATE.DRIFT,
      target: candidates[0],
      changes,
      reason: `${describe} exists but points elsewhere: ${changes
        .map((change) => `${change.field} is ${change.from}, expected ${change.to}`)
        .join(", ")}.`
    };
  }

  if (candidates.length > 1) {
    return {
      state: RECONCILE_STATE.AMBIGUOUS,
      target: null,
      changes: [],
      // Two comparable entries and neither matches means we cannot know which
      // one was meant. Picking either would silently rewrite something a person
      // deliberately created, so this state never leads to a write.
      reason: `${candidates.length} comparable entries exist and none match, so Stackarr cannot tell which one you meant. Resolve this in the app itself.`
    };
  }

  return {
    state: RECONCILE_STATE.ABSENT,
    target: null,
    changes: [],
    reason: `${describe} is not configured.`
  };
}

/**
 * SABnzbd's implementation string is `Sabnzbd`; `SABnzbd` is only the default
 * display name. Compared case-insensitively so neither spelling matters.
 */
export function reconcileDownloadClient(existing = [], desired) {
  const candidates = existing.filter(
    (client) => String(client?.implementation || "").toLowerCase() === "sabnzbd"
  );

  return reconcile({
    candidates,
    describe: "The SABnzbd download client",
    matches: (client) =>
      String(fieldValue(client, "host")) === String(desired.host) &&
      Number(fieldValue(client, "port")) === Number(desired.port),
    describeChanges: (client) => {
      const changes = [];
      const host = fieldValue(client, "host");
      const port = fieldValue(client, "port");

      if (String(host) !== String(desired.host)) {
        changes.push({ field: "host", from: host, to: desired.host });
      }

      if (Number(port) !== Number(desired.port)) {
        changes.push({ field: "port", from: port, to: desired.port });
      }

      return changes;
    }
  });
}

/** A Prowlarr application entry, one per Arr app it syncs indexers into. */
export function reconcileApplication(existing = [], desired) {
  const candidates = existing.filter(
    (application) =>
      String(application?.implementation || "").toLowerCase() === String(desired.implementation).toLowerCase()
  );

  return reconcile({
    candidates,
    describe: `${desired.implementation} in Prowlarr`,
    matches: (application) => normalizeUrl(fieldValue(application, "baseUrl")) === normalizeUrl(desired.baseUrl),
    describeChanges: (application) => [
      { field: "baseUrl", from: fieldValue(application, "baseUrl"), to: desired.baseUrl }
    ]
  });
}

/**
 * Reconciles a link held as fields in a settings document rather than as an
 * entry in a collection.
 *
 * Bazarr keeps one `sonarr:` block and one `radarr:` block, so there is nothing
 * to match on and nothing to duplicate — only whether the block points at the
 * right place and is switched on. `absent` means the toggle is off; `drift`
 * means it is on but aimed somewhere else, which is still never overwritten.
 */
export function reconcileSettingsLink({ enabled, current, desired, describe }) {
  const changes = Object.keys(desired)
    .filter((field) => String(current?.[field] ?? "") !== String(desired[field]))
    .map((field) => ({ field, from: current?.[field] ?? null, to: desired[field] }));

  if (!enabled) {
    return {
      state: RECONCILE_STATE.ABSENT,
      target: null,
      changes,
      reason: `${describe} is not enabled.`
    };
  }

  if (changes.length === 0) {
    return {
      state: RECONCILE_STATE.CORRECT,
      target: current,
      changes: [],
      reason: `${describe} is already configured correctly.`
    };
  }

  return {
    state: RECONCILE_STATE.DRIFT,
    target: current,
    changes,
    reason: `${describe} is enabled but points elsewhere: ${changes
      .map((change) => `${change.field} is ${change.from}, expected ${change.to}`)
      .join(", ")}.`
  };
}

/**
 * Root folders are compared by containment rather than by exact path, because
 * the folder a user picked inside their media mount is their business. A
 * library at /Media/Films is correct; only having nothing there is not.
 */
export function reconcileRootFolder(existing = [], { mountPath, expectedPath }) {
  const inside = existing.filter(
    (folder) => folder?.path === mountPath || String(folder?.path || "").startsWith(`${mountPath}/`)
  );

  if (inside.length > 0) {
    return {
      state: RECONCILE_STATE.CORRECT,
      target: inside[0],
      changes: [],
      reason: `A root folder is configured at ${inside.map((folder) => folder.path).join(", ")}.`
    };
  }

  return {
    state: RECONCILE_STATE.ABSENT,
    target: null,
    changes: [],
    reason: `No root folder is configured inside ${mountPath}. Stackarr would add ${expectedPath}.`
  };
}
