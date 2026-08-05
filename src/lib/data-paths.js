import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const dataDir = process.env.STACKARR_DATA_DIR
  ? path.resolve(process.env.STACKARR_DATA_DIR)
  : path.resolve(here, "..", "..", "data");

export const settingsPath = path.join(dataDir, "settings.json");
export const activityPath = path.join(dataDir, "activity.json");
export const updatesPath = path.join(dataDir, "updates.json");
export const logPath = process.env.STACKARR_LOG_PATH
  ? path.resolve(process.env.STACKARR_LOG_PATH)
  : path.join(dataDir, "stackarr.log");
