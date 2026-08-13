/**
 * The library folder each app keeps inside the shared media mount. Only used to
 * name a folder that does not exist yet — an app that already has a root folder
 * somewhere else in the mount is left alone.
 */
const MEDIA_SUBFOLDER = Object.freeze({
  radarr: "Movies",
  sonarr: "TV",
  lidarr: "Music"
});

export function readMounts(inspect) {
  return (inspect?.Mounts || []).map((mount) => ({
    source: mount.Source,
    target: mount.Destination
  }));
}

function longestMatch(mounts, pathValue, side) {
  const other = side === "source" ? "target" : "source";

  return (
    mounts
      .filter((mount) => pathValue === mount[side] || String(pathValue).startsWith(`${mount[side]}/`))
      .sort((a, b) => b[side].length - a[side].length)
      .map((mount) => ({ mount, mapped: `${mount[other]}${String(pathValue).slice(mount[side].length)}` }))[0] || null
  );
}

/** Translates a path inside a container to the host path backing it. */
export function containerPathToHost(mounts, containerPath) {
  return longestMatch(mounts, containerPath, "target")?.mapped || null;
}

/** Translates a host path to where that same data appears inside a container. */
export function hostPathToContainer(mounts, hostPath) {
  return longestMatch(mounts, hostPath, "source")?.mapped || null;
}

/**
 * Works out the root folder an app should have.
 *
 * Derived from the container's own media mount, never from `settings.mediaRoot`.
 * That setting is a *host* path — on this stack `/share/Media` — while the app
 * only ever sees `/Media`. Composing the host path with a library name produces
 * `/share/Media/Movies`, which the app will accept and then never find anything
 * in. Same class of mistake as addressing a container at the wrong host.
 */
export function planRootFolder(mounts, serviceId, mediaRoot) {
  const subfolder = MEDIA_SUBFOLDER[serviceId];

  if (!subfolder) {
    return { ok: false, reason: `Keelarr does not manage a library folder for ${serviceId}.` };
  }

  const mountPath = hostPathToContainer(mounts, mediaRoot);

  if (!mountPath) {
    return {
      ok: false,
      // A root folder cannot be invented for storage the container cannot see.
      reason: `The container does not mount ${mediaRoot}, so it has no view of the media library.`
    };
  }

  return {
    ok: true,
    mountPath,
    expectedPath: `${mountPath}/${subfolder}`,
    derivedFrom: `the ${mountPath} mount`
  };
}

/**
 * Decides whether the Arr app needs a remote path mapping for the download
 * client's completed folder.
 *
 * The question is not whether the two containers use the same path, but whether
 * the same *data* appears at the same path in both. Resolve the download
 * client's completed folder to a host path, then ask where the Arr sees that
 * host path. Equal paths mean no mapping. Different paths mean a mapping.
 * Nowhere at all means the mount is missing, and no mapping can fix that.
 */
export function planPathMapping({ downloadMounts, completeDir, arrMounts, downloadHost }) {
  if (!completeDir) {
    return { needed: false, blocked: false, reason: "The download client has no completed folder configured yet." };
  }

  const hostPath = containerPathToHost(downloadMounts, completeDir);

  if (!hostPath) {
    return {
      needed: false,
      blocked: true,
      reason: `The download client writes to ${completeDir}, which is not backed by any host mount, so nothing else can reach it.`
    };
  }

  const arrPath = hostPathToContainer(arrMounts, hostPath);

  if (!arrPath) {
    return {
      needed: false,
      blocked: true,
      reason: `Completed downloads land in ${hostPath} on the host, which this app does not mount. A path mapping cannot fix a missing mount — add the volume instead.`
    };
  }

  if (arrPath === completeDir) {
    return {
      needed: false,
      blocked: false,
      reason: `The download client and this app both see completed downloads at ${completeDir}, so no mapping is required.`
    };
  }

  return {
    needed: true,
    blocked: false,
    mapping: { host: downloadHost, remotePath: completeDir, localPath: arrPath },
    reason: `The download client reports completed downloads at ${completeDir}, but this app sees the same folder at ${arrPath}.`
  };
}
