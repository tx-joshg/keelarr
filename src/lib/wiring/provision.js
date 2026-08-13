import { chmod, chown, mkdir, stat } from "node:fs/promises";
import path from "node:path";

import { containerPathToHost } from "./path-plan.js";

/**
 * Creates a library folder the app is about to be pointed at.
 *
 * Keelarr already writes download clients into these apps and sets their root
 * folders. Declining to create a directory inside the media root the operator
 * configured is an inconsistent place to stop — an install that ends with two
 * manual chores is not the one-click install it claims to be.
 *
 * The folder is created on the *host* path behind the container path, because
 * the controller sees /share/Media while the app sees /Media, and it copies the
 * ownership and mode of a sibling the app already writes to rather than
 * guessing from PUID. A folder that matches a proven-working one is far more
 * likely to be writable than one built from settings that may not reflect
 * reality.
 */
export async function ensureLibraryFolder(mounts, containerPath, options = {}) {
  const mkdirImpl = options.mkdirImpl || mkdir;
  const statImpl = options.statImpl || stat;
  const hostPath = containerPathToHost(mounts, containerPath);

  if (!hostPath) {
    return {
      ok: false,
      reason: `${containerPath} is not backed by a host directory Keelarr can reach, so it cannot be created here.`
    };
  }

  // The mount root has to be there before anything is created inside it. A
  // missing one means the volume is not mounted, and writing into the empty
  // mount point would leave a directory that vanishes behind the real storage
  // the moment it does mount.
  const mountSource = mounts
    .filter((mount) => containerPath === mount.target || containerPath.startsWith(`${mount.target}/`))
    .sort((a, b) => b.target.length - a.target.length)[0]?.source;

  try {
    await statImpl(mountSource);
  } catch {
    return {
      ok: false,
      reason: `${mountSource} does not exist on this host, so ${containerPath} cannot be created inside it. The volume may not be mounted.`
    };
  }

  try {
    await statImpl(hostPath);
    return { ok: true, created: false, hostPath };
  } catch {
    // Not there yet, which is the case worth handling.
  }

  // Walk up to the nearest directory that does exist and copy that. The
  // immediate parent may be missing too when the library path is nested, and
  // the closest real ancestor is still the best available evidence of what
  // permissions work on this share.
  let template = null;
  let ancestor = path.dirname(hostPath);

  while (!template) {
    try {
      template = await statImpl(ancestor);
    } catch {
      const next = path.dirname(ancestor);

      if (next === ancestor) {
        return {
          ok: false,
          reason: `Nothing above ${hostPath} exists, so ${containerPath} cannot be created.`
        };
      }

      ancestor = next;
    }
  }

  try {
    await mkdirImpl(hostPath, { recursive: true });
    // Match the parent rather than trusting a default umask: these shares are
    // frequently world-writable on purpose, and an app that cannot write to its
    // own library folder fails in ways that are tedious to diagnose.
    await (options.chmodImpl || chmod)(hostPath, template.mode & 0o777);
    await (options.chownImpl || chown)(hostPath, template.uid, template.gid);
  } catch (error) {
    return { ok: false, reason: `Could not create ${hostPath}: ${error.message}` };
  }

  return { ok: true, created: true, hostPath };
}
