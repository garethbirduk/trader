import { describe, it, expect } from "vitest";
import {
  absoluteHour,
  advanceOneHour,
  cloneClock,
  formatClock,
  HOURS_PER_DAY,
  makeClock,
} from "../src/engine/core/clock.js";

describe("clock", () => {
  it("constructs valid clocks", () => {
    const c = makeClock(1, 9);
    expect(c.day).toBe(1);
    expect(c.hour).toBe(9);
  });

  it("rejects invalid clock values", () => {
    expect(() => makeClock(0, 0)).toThrow();
    expect(() => makeClock(-1, 0)).toThrow();
    expect(() => makeClock(1, -1)).toThrow();
    expect(() => makeClock(1, HOURS_PER_DAY)).toThrow();
    expect(() => makeClock(1.5, 0)).toThrow();
    expect(() => makeClock(1, 0.5)).toThrow();
  });

  it("advances one hour without rollover", () => {
    const c = cloneClock(makeClock(1, 9));
    const r = advanceOneHour(c);
    expect(c).toEqual({ day: 1, hour: 10 });
    expect(r.rolledOverFromDay).toBeNull();
  });

  it("rolls over at midnight", () => {
    const c = cloneClock(makeClock(3, 23));
    const r = advanceOneHour(c);
    expect(c).toEqual({ day: 4, hour: 0 });
    expect(r.rolledOverFromDay).toBe(3);
  });

  it("computes absolute hour", () => {
    expect(absoluteHour(makeClock(1, 0))).toBe(0);
    expect(absoluteHour(makeClock(1, 23))).toBe(23);
    expect(absoluteHour(makeClock(2, 0))).toBe(24);
    expect(absoluteHour(makeClock(3, 9))).toBe(57);
  });

  it("formats compactly", () => {
    expect(formatClock(makeClock(1, 9))).toBe("D01 09:00");
    expect(formatClock(makeClock(14, 23))).toBe("D14 23:00");
  });
});
