import { describe, expect, it } from "vitest";

import {
  activePause,
  MAX_PAUSE_MS,
  parseDuration,
  parsePause,
  pauseRecord,
} from "./pause.js";

/** RFX-126 — a pause is bounded, mandatory in duration, and ends by itself. */
const NOW = new Date("2026-10-04T10:00:00.000Z");

describe("the pause record", () => {
  it("reads durations in whole units and refuses what is not one, or too long", () => {
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("2h")).toBe(2 * 3_600_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("1d")).toBe(MAX_PAUSE_MS);
    for (const bad of [
      "",
      "30",
      "m",
      "0s",
      "2d",
      "25h",
      "1.5h",
      "forever",
      "-5m",
      "999999m",
    ]) {
      expect(parseDuration(bad), bad).toBeUndefined();
    }
  });

  it("is in force until its end, and not a millisecond after", () => {
    const record = pauseRecord(NOW, 30 * 60_000, "upgrading the daemon");
    expect(record).toEqual({
      version: 1,
      pausedAt: "2026-10-04T10:00:00.000Z",
      until: "2026-10-04T10:30:00.000Z",
      reason: "upgrading the daemon",
    });
    expect(activePause(record, NOW)).toEqual(record);
    expect(activePause(record, new Date("2026-10-04T10:29:59.999Z"))).toEqual(
      record,
    );
    expect(
      activePause(record, new Date("2026-10-04T10:30:00.000Z")),
    ).toBeUndefined();
    expect(activePause(undefined, NOW)).toBeUndefined();
  });

  // Adversarial: a pause file the agent wrote by hand, or a damaged one,
  // must never switch enforcement off.
  it("reads anything it does not understand as no pause", () => {
    for (const text of [
      undefined,
      "",
      "nope",
      "{}",
      JSON.stringify({
        version: 2,
        pausedAt: "x",
        until: "2099-01-01T00:00:00Z",
      }),
      JSON.stringify({ version: 1, pausedAt: "x", until: "never" }),
    ]) {
      expect(parsePause(text)).toBeUndefined();
    }
    const good = pauseRecord(NOW, 60_000);
    expect(parsePause(JSON.stringify(good))).toEqual(good);
  });
});
