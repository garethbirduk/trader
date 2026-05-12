import { describe, it, expect } from "vitest";
import { DiaryAlertRegistry } from "../src/engine/world/diary-alerts.js";

describe("DiaryAlertRegistry", () => {
  it("returns null when no alert applies", () => {
    const r = new DiaryAlertRegistry();
    expect(r.getAlertAt(1, { day: 1, hour: 10 })).toBeNull();
  });

  it("returns the active alert when the clock falls in the window", () => {
    const r = new DiaryAlertRegistry();
    r.setAlert({
      actorId: 42,
      destinationLocationId: 7,
      fromDay: 1, fromHour: 10,
      toDay: 1, toHour: 12,
      reason: "tip",
    });
    expect(r.getAlertAt(42, { day: 1, hour: 9 })).toBeNull();
    expect(r.getAlertAt(42, { day: 1, hour: 10 })?.destinationLocationId).toBe(7);
    expect(r.getAlertAt(42, { day: 1, hour: 12 })?.destinationLocationId).toBe(7);
    expect(r.getAlertAt(42, { day: 1, hour: 13 })).toBeNull();
    expect(r.getAlertAt(99, { day: 1, hour: 11 })).toBeNull(); // different actor
  });

  it("the freshest alert wins when two overlap", () => {
    const r = new DiaryAlertRegistry();
    r.setAlert({
      actorId: 1, destinationLocationId: 100,
      fromDay: 1, fromHour: 10, toDay: 1, toHour: 14,
      reason: "old",
    });
    r.setAlert({
      actorId: 1, destinationLocationId: 200,
      fromDay: 1, fromHour: 12, toDay: 1, toHour: 13,
      reason: "fresh",
    });
    const a = r.getAlertAt(1, { day: 1, hour: 12 });
    expect(a?.destinationLocationId).toBe(200);
    expect(a?.reason).toBe("fresh");
  });

  it("pruneExpired drops alerts whose window has ended", () => {
    const r = new DiaryAlertRegistry();
    r.setAlert({
      actorId: 1, destinationLocationId: 10,
      fromDay: 1, fromHour: 10, toDay: 1, toHour: 12, reason: "done",
    });
    r.setAlert({
      actorId: 1, destinationLocationId: 20,
      fromDay: 2, fromHour: 8, toDay: 2, toHour: 10, reason: "live",
    });
    r.pruneExpired({ day: 2, hour: 0 });
    const snap = r.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.reason).toBe("live");
  });

  it("rejects invalid windows", () => {
    const r = new DiaryAlertRegistry();
    expect(() =>
      r.setAlert({
        actorId: 1, destinationLocationId: 10,
        fromDay: 2, fromHour: 10, toDay: 1, toHour: 10, reason: "bad",
      }),
    ).toThrow();
    expect(() =>
      r.setAlert({
        actorId: 1, destinationLocationId: 10,
        fromDay: 1, fromHour: 12, toDay: 1, toHour: 10, reason: "bad",
      }),
    ).toThrow();
  });
});
