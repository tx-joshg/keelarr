import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const dataDir = process.env.KEELARR_DATA_DIR
  ? path.resolve(process.env.KEELARR_DATA_DIR)
  : path.resolve(here, "..", "..", "data");

export const settingsPath = path.join(dataDir, "settings.json");
export const activityPath = path.join(dataDir, "activity.json");
export const updatesPath = path.join(dataDir, "updates.json");
export const jobsPath = path.join(dataDir, "jobs.json");
// Kept apart from settings.json on purpose: settings are rendered into
// deploy/.env and reported through the API, and the password hash belongs in
// neither.
export const authPath = path.join(dataDir, "auth.json");
export const logPath = process.env.KEELARR_LOG_PATH
  ? path.resolve(process.env.KEELARR_LOG_PATH)
  : path.join(dataDir, "keelarr.log");
