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
// Deliberately not a key inside updates.json: isUpdateCheckDue() takes the
// newest checkedAt across every value in that file, so recording a controller
// check there would postpone the managed services' next check by a day.
export const controllerUpdatePath = path.join(dataDir, "controller-update.json");
// The record of an update in flight. In the data directory because that is a
// bind mount: it is the only thing written by the old controller that the new
// one can still read.
export const selfUpdateReceiptPath = path.join(dataDir, "self-update.json");
export const selfUpdateLogPath = path.join(dataDir, "self-update.log");
export const selfUpdateAckPath = (operationId) => path.join(dataDir, `self-update-ack-${operationId}`);
// When the last install window ran and what it did. Its own file, for the same
// reason as controller-update.json: isUpdateCheckDue() walks every value in
// updates.json, and a key here would be mistaken for a service entry.
export const autoUpdatePath = path.join(dataDir, "auto-update.json");
// Kept apart from settings.json on purpose: settings are rendered into
// deploy/.env and reported through the API, and the password hash belongs in
// neither.
export const authPath = path.join(dataDir, "auth.json");
export const logPath = process.env.KEELARR_LOG_PATH
  ? path.resolve(process.env.KEELARR_LOG_PATH)
  : path.join(dataDir, "keelarr.log");
