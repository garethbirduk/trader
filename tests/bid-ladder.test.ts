import { describe, it, expect } from "vitest";
import {
  BID_LADDER,
  nextRungAbove,
  rungAtOrAbove,
  rungAtOrBelow,
} from "../src/engine/auction/bid-ladder.js";

describe("bid ladder", () => {
  it("starts with the canonical small-step rungs", () => {
    expect(BID_LADDER.slice(0, 14)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20,
    ]);
  });

  it("transitions cleanly between bands", () => {
    // After 20, jumps to 25 (band 2 starts at 25).
    const i20 = BID_LADDER.indexOf(20);
    expect(BID_LADDER[i20 + 1]).toBe(25);

    // After 50, jumps to 60 (band 3 starts at 60).
    const i50 = BID_LADDER.indexOf(50);
    expect(BID_LADDER[i50 + 1]).toBe(60);

    // After 100, jumps to 125.
    const i100 = BID_LADDER.indexOf(100);
    expect(BID_LADDER[i100 + 1]).toBe(125);

    // After 1000, jumps to 1250.
    const i1000 = BID_LADDER.indexOf(1000);
    expect(BID_LADDER[i1000 + 1]).toBe(1250);
  });

  it("nextRungAbove returns the smallest rung > amount", () => {
    expect(nextRungAbove(0)).toBe(1);
    expect(nextRungAbove(1)).toBe(2);
    expect(nextRungAbove(8)).toBe(10);
    expect(nextRungAbove(9)).toBe(10);
    expect(nextRungAbove(10)).toBe(12);
    expect(nextRungAbove(40)).toBe(45);
    expect(nextRungAbove(50)).toBe(60);
    expect(nextRungAbove(100)).toBe(125);
    expect(nextRungAbove(190)).toBe(200);
    expect(nextRungAbove(200)).toBe(250);
  });

  it("rungAtOrBelow returns the highest rung <= amount", () => {
    expect(rungAtOrBelow(0)).toBe(0);
    expect(rungAtOrBelow(1)).toBe(1);
    expect(rungAtOrBelow(9)).toBe(8);
    expect(rungAtOrBelow(11)).toBe(10);
    expect(rungAtOrBelow(73)).toBe(70);
    expect(rungAtOrBelow(99)).toBe(90);
    expect(rungAtOrBelow(100)).toBe(100);
    expect(rungAtOrBelow(2244)).toBe(2000);
  });

  it("rungAtOrAbove returns the lowest rung >= amount", () => {
    expect(rungAtOrAbove(0)).toBe(1);
    expect(rungAtOrAbove(1)).toBe(1);
    expect(rungAtOrAbove(9)).toBe(10);
    expect(rungAtOrAbove(11)).toBe(12);
    expect(rungAtOrAbove(73)).toBe(80);
    expect(rungAtOrAbove(100)).toBe(100);
    expect(rungAtOrAbove(101)).toBe(125);
    expect(rungAtOrAbove(340)).toBe(350);
  });

  it("extrapolates beyond £1M with £100k tail steps", () => {
    expect(nextRungAbove(1_000_000)).toBe(1_100_000);
    expect(nextRungAbove(1_500_000)).toBe(1_600_000);
    expect(rungAtOrBelow(1_550_000)).toBe(1_500_000);
  });
});
