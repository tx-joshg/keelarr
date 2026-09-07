/**
 * Wall-clock reading in a named time zone, with no dependencies.
 *
 * The scheduler asks one question — "is it 03:00 yet, where this NAS lives?"
 * — and Node's Intl is enough to answer it. Everything here is pure and takes
 * an epoch so tests can pick the instant.
 */

const pad = (value) => String(value).padStart(2, "0");

/** "3:05" or "03:05" → { hour: 3, minute: 5 }; null for anything else. */
export function parseClockTime(value) {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(value ?? ""));

  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (hour > 23 || minute > 59) {
    return null;
  }

  return { hour, minute };
}

export function formatClockTime({ hour, minute }) {
  return `${pad(hour)}:${pad(minute)}`;
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: String(tz || "") });
    return true;
  } catch {
    return false;
  }
}

/**
 * The local hour, minute and calendar day at an instant, in a zone.
 *
 * An unknown zone falls back to UTC rather than throwing: settings.tz is not
 * validated anywhere, and a typo there must not take the scheduler down. The
 * fallback is reported so the caller can say the window is in UTC.
 */
export function localClockIn(tz, epochMs) {
  const zone = isValidTimeZone(tz) ? tz : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(new Date(epochMs));
  const part = (type) => parts.find((entry) => entry.type === type)?.value;

  return {
    hour: Number(part("hour")) % 24,
    minute: Number(part("minute")),
    dayKey: `${part("year")}-${part("month")}-${part("day")}`,
    tzFallback: zone !== tz
  };
}
