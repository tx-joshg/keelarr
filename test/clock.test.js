import test from "node:test";
import assert from "node:assert/strict";

import { formatClockTime, isValidTimeZone, localClockIn, parseClockTime } from "../src/lib/clock.js";

const INSTANT = Date.parse("2026-09-07T08:30:00.000Z");

test("the local clock is read in the configured time zone, not the process's", () => {
  // One instant, three answers. Chicago is on daylight time in September.
  assert.deepEqual(localClockIn("America/Chicago", INSTANT), { hour: 3, minute: 30, dayKey: "2026-09-07", tzFallback: false });
  assert.deepEqual(localClockIn("Asia/Tokyo", INSTANT), { hour: 17, minute: 30, dayKey: "2026-09-07", tzFallback: false });
  assert.deepEqual(localClockIn("UTC", INSTANT), { hour: 8, minute: 30, dayKey: "2026-09-07", tzFallback: false });
});

test("a day boundary in the zone is the zone's, not UTC's", () => {
  // 03:00 UTC on the 7th is still the evening of the 6th in Chicago.
  const local = localClockIn("America/Chicago", Date.parse("2026-09-07T03:00:00.000Z"));
  assert.equal(local.dayKey, "2026-09-06");
  assert.equal(local.hour, 22);
});

test("midnight reads as hour zero", () => {
  assert.equal(localClockIn("UTC", Date.parse("2026-09-07T00:05:00.000Z")).hour, 0);
});

test("an unknown time zone falls back to UTC rather than crashing the scheduler", () => {
  // settings.tz is not validated anywhere. A typo there must be survivable.
  const local = localClockIn("Mars/Olympus", INSTANT);
  assert.equal(local.tzFallback, true);
  assert.equal(local.hour, 8);
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
  assert.equal(isValidTimeZone("America/Chicago"), true);
  assert.equal(isValidTimeZone(""), false);
});

test("a clock time is H:MM or HH:MM on a 24-hour clock, and nothing else", () => {
  assert.deepEqual(parseClockTime("3:05"), { hour: 3, minute: 5 });
  assert.deepEqual(parseClockTime("03:05"), { hour: 3, minute: 5 });
  assert.deepEqual(parseClockTime(" 23:59 "), { hour: 23, minute: 59 });
  assert.equal(parseClockTime("24:00"), null);
  assert.equal(parseClockTime("3pm"), null);
  assert.equal(parseClockTime("03:60"), null);
  assert.equal(parseClockTime(""), null);
  assert.equal(parseClockTime(undefined), null);
  assert.equal(parseClockTime(7), null);
  assert.equal(formatClockTime({ hour: 3, minute: 5 }), "03:05");
});
