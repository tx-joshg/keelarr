import { localClockIn, parseClockTime } from "./clock.js";

// How long a window stays open after its time. Long enough to outlast a job
// that happened to be running at the minute, short enough that "installs at
// 03:00" stays roughly true.
export const AUTO_UPDATE_TOLERANCE_MS = 30 * 60 * 1000;

export function previousDayKey(dayKey) {
  const date = new Date(`${dayKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Whether the install window is open right now and has not been used.
 *
 * A window is [HH:MM, HH:MM + tolerance) in the configured zone. A run is keyed
 * by the local date the window opened on, so it fires once per day, and a
 * window missed entirely — the controller was down — is simply tomorrow's.
 * There is deliberately no catch-up at boot: "unattended at a time I chose"
 * must not become "unattended whenever it happened to start".
 */
/**
 * Where "now" sits relative to the configured window: how many minutes past
 * its opening, which local day it belongs to, and whether it is open.
 *
 * A window that opens before midnight closes after it. Just past midnight,
 * the open window belongs to yesterday.
 */
function locateWindow({ now, settings, target, toleranceMs }) {
  const local = localClockIn(settings.tz, now);
  const toleranceMinutes = toleranceMs / 60_000;
  let offsetMinutes = local.hour * 60 + local.minute - (target.hour * 60 + target.minute);
  let windowKey = local.dayKey;

  if (offsetMinutes < 0 && offsetMinutes + 1440 < toleranceMinutes) {
    offsetMinutes += 1440;
    windowKey = previousDayKey(local.dayKey);
  }

  return {
    local,
    offsetMinutes,
    windowKey,
    open: offsetMinutes >= 0 && offsetMinutes < toleranceMinutes
  };
}

export function decideAutoUpdate({ now, settings, state, toleranceMs = AUTO_UPDATE_TOLERANCE_MS }) {
  if (settings?.autoUpdateEnabled !== true) {
    return { run: false, reason: "disabled" };
  }

  const target = parseClockTime(settings.autoUpdateTime);

  if (!target) {
    return { run: false, reason: "invalid-time" };
  }

  const { local, windowKey, open } = locateWindow({ now, settings, target, toleranceMs });

  if (!open) {
    return { run: false, reason: "outside-window", windowKey };
  }

  if (state?.lastWindowKey === windowKey) {
    return { run: false, reason: "already-ran", windowKey };
  }

  return { run: true, windowKey, tzFallback: local.tzFallback === true };
}

/**
 * When the next window opens, as an ISO instant.
 *
 * A window that is open right now and has not been used is the next run —
 * the scheduler may start it on the next tick, so "tomorrow" would be wrong
 * for the half hour it stands aside behind another job. Otherwise it counts
 * minutes from the local clock, so across a DST change it can be an hour
 * out. That is acceptable for a dashboard hint and documented as such.
 */
export function describeNextRun({ now, settings, state = null, toleranceMs = AUTO_UPDATE_TOLERANCE_MS }) {
  const target = parseClockTime(settings?.autoUpdateTime);

  if (!target) {
    return null;
  }

  const { local, offsetMinutes, windowKey, open } = locateWindow({ now, settings, target, toleranceMs });

  if (open && state?.lastWindowKey !== windowKey) {
    const thisMinute = Math.floor(now / 60_000) * 60_000;
    return new Date(thisMinute - offsetMinutes * 60_000).toISOString();
  }

  const minutesUntil = (target.hour * 60 + target.minute - (local.hour * 60 + local.minute) + 1440) % 1440 || 1440;

  return new Date(now + minutesUntil * 60_000).toISOString();
}
