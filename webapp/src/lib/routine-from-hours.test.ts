import { describe, it, expect } from "vitest";
import { deriveRoutineFromVenue } from "./routine-from-hours.js";

describe("deriveRoutineFromVenue", () => {
  it("Mon-Fri venue → weekday-only schedule, weekend empty", () => {
    const r = deriveRoutineFromVenue("shop", {
      openSessions: [{ daysOfWeek: [1, 2, 3, 4, 5], start: 9, end: 17 }],
    });
    expect(r.schedule).toEqual([{ from: 9, to: 17, location: "shop" }]);
    expect(r.weekendSchedule).toEqual([]);
  });

  it("Mon-Sun uniform → schedule + weekendSchedule with the same hours", () => {
    const r = deriveRoutineFromVenue("pub", {
      openSessions: [
        { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], start: 11, end: 23 },
      ],
    });
    expect(r.schedule).toEqual([{ from: 11, to: 23, location: "pub" }]);
    expect(r.weekendSchedule).toEqual([{ from: 11, to: 23, location: "pub" }]);
  });

  it("Mon-Fri 9-17 + Sat 10-14 → split correctly", () => {
    const r = deriveRoutineFromVenue("market", {
      openSessions: [
        { daysOfWeek: [1, 2, 3, 4, 5], start: 9, end: 17 },
        { daysOfWeek: [6], start: 10, end: 14 },
      ],
    });
    expect(r.schedule).toEqual([{ from: 9, to: 17, location: "market" }]);
    expect(r.weekendSchedule).toEqual([{ from: 10, to: 14, location: "market" }]);
  });

  it("Sat-only venue → weekday empty, weekend gets the session", () => {
    const r = deriveRoutineFromVenue("weekend-market", {
      openSessions: [{ daysOfWeek: [6], start: 8, end: 16 }],
    });
    expect(r.schedule).toEqual([]);
    expect(r.weekendSchedule).toEqual([
      { from: 8, to: 16, location: "weekend-market" },
    ]);
  });

  it("Conflicting weekday sessions → picks the most common", () => {
    // 4 of 5 weekdays say 9-17, one says 10-18. Most-common is 9-17.
    const r = deriveRoutineFromVenue("shop", {
      openSessions: [
        { daysOfWeek: [1, 2, 3, 4], start: 9, end: 17 },
        { daysOfWeek: [5], start: 10, end: 18 },
      ],
    });
    expect(r.schedule).toEqual([{ from: 9, to: 17, location: "shop" }]);
  });

  it("Falls back to openHours when openSessions absent", () => {
    const r = deriveRoutineFromVenue("compact", {
      openHours: { start: 8, end: 16 },
      openDaysOfWeek: [1, 2, 3, 4, 5, 6],
    });
    expect(r.schedule).toEqual([{ from: 8, to: 16, location: "compact" }]);
    expect(r.weekendSchedule).toEqual([
      { from: 8, to: 16, location: "compact" },
    ]);
  });

  it("openHours without openDaysOfWeek defaults to all 7 days", () => {
    const r = deriveRoutineFromVenue("always-open", {
      openHours: { start: 0, end: 24 },
    });
    expect(r.schedule).toEqual([{ from: 0, to: 24, location: "always-open" }]);
    expect(r.weekendSchedule).toEqual([
      { from: 0, to: 24, location: "always-open" },
    ]);
  });

  it("Venue with no hours at all → both empty", () => {
    const r = deriveRoutineFromVenue("nowhere", {});
    expect(r.schedule).toEqual([]);
    expect(r.weekendSchedule).toEqual([]);
  });

  it("Past-midnight window (end > 24) is preserved through derivation", () => {
    // Riverside-style Fri-Sat 18→26 (open until 02:00 next morning).
    const r = deriveRoutineFromVenue("club", {
      openSessions: [{ daysOfWeek: [5, 6], start: 18, end: 26 }],
    });
    // Day 5 (Fri) is a weekday; day 6 (Sat) is weekend.
    expect(r.schedule).toEqual([{ from: 18, to: 26, location: "club" }]);
    expect(r.weekendSchedule).toEqual([{ from: 18, to: 26, location: "club" }]);
  });

  it("Empty openSessions array falls through to openHours expansion", () => {
    const r = deriveRoutineFromVenue("legacy", {
      openSessions: [],
      openHours: { start: 9, end: 17 },
      openDaysOfWeek: [1, 2, 3, 4, 5],
    });
    expect(r.schedule).toEqual([{ from: 9, to: 17, location: "legacy" }]);
    expect(r.weekendSchedule).toEqual([]);
  });
});
