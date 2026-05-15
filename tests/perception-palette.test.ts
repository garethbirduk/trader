import { describe, it, expect } from "vitest";
import {
  PALETTE_STOPS,
  PALETTE_HEX,
  bandCount,
  colourFor,
} from "../src/engine/perception/palette.js";

describe("palette — sanity", () => {
  it("exposes 10 stops, matching the doc's commitment", () => {
    expect(PALETTE_STOPS).toBe(10);
    expect(PALETTE_HEX).toHaveLength(10);
  });
});

describe("bandCount — j gates resolution", () => {
  it("j=1.0 sees all 10 bands", () => {
    expect(bandCount(1.0)).toBe(10);
  });

  it("j=0.5 sees 5 bands", () => {
    expect(bandCount(0.5)).toBe(5);
  });

  it("j=0.1 collapses to 1 band", () => {
    expect(bandCount(0.1)).toBe(1);
  });

  it("j=0 still leaves at least 1 band (everything one colour)", () => {
    expect(bandCount(0)).toBe(1);
  });

  it("out-of-range j is clamped", () => {
    expect(bandCount(-0.5)).toBe(1);
    expect(bandCount(2.0)).toBe(10);
  });
});

describe("colourFor — band-collapsed mapping", () => {
  it("at j=1 distinguishes neighbouring values", () => {
    const a = colourFor(0.95, 1.0);
    const b = colourFor(0.85, 1.0);
    expect(a).not.toBe(b);
  });

  it("at j=0.2 (2 bands) collapses 0.95 and 0.85 to the same colour", () => {
    // Both fall in the upper band [0.5, 1.0]; midpoint 0.75; mapped to
    // floor(0.75 * 10) = 7.
    expect(colourFor(0.95, 0.2)).toBe(colourFor(0.85, 0.2));
  });

  it("at j=0.2 the lower band differs from the upper band", () => {
    expect(colourFor(0.2, 0.2)).not.toBe(colourFor(0.8, 0.2));
  });

  it("returns an index within [0, PALETTE_STOPS)", () => {
    for (const v of [0, 0.1, 0.5, 0.9, 1.0]) {
      for (const j of [0.1, 0.5, 1.0]) {
        const idx = colourFor(v, j);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(PALETTE_STOPS);
      }
    }
  });

  it("clamps values outside [0, 1]", () => {
    expect(colourFor(-1, 1.0)).toBe(colourFor(0, 1.0));
    expect(colourFor(5, 1.0)).toBe(colourFor(1.0, 1.0));
  });

  it("monotonic at j=1: higher value → higher-or-equal index", () => {
    let prev = -1;
    for (let v = 0; v <= 1.001; v += 0.05) {
      const idx = colourFor(v, 1.0);
      expect(idx).toBeGreaterThanOrEqual(prev);
      prev = idx;
    }
  });
});
