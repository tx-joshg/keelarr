import path from "node:path";
import { readdir } from "node:fs/promises";

import { StackarrError } from "./errors.js";

function normalizeDirectoryPath(inputPath = "/") {
  const trimmed = String(inputPath || "").trim();
  return path.resolve("/", trimmed || "/");
}

export async function listDirectories(inputPath = "/") {
  const targetPath = normalizeDirectoryPath(inputPath);
  let entries;

  try {
    entries = await readdir(targetPath, {
      withFileTypes: true
    });
  } catch (error) {
    throw new StackarrError(`Unable to browse ${targetPath}.`, {
      statusCode: error.code === "ENOENT" ? 404 : 400,
      details: {
        code: error.code || "BROWSE_FAILED",
        path: targetPath
      }
    });
  }

  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(targetPath, entry.name)
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    ok: true,
    path: targetPath,
    parentPath: targetPath === "/" ? null : path.dirname(targetPath),
    directories
  };
}
