/**
 * Exploratory scenario — not a behavioural test. Shows what the current
 * `appraiseLot` produces across a spread of judgement values. Kept for
 * future fine-tuning of the judgement / band model and as an informal
 * snapshot — if numbers drift, something upstream in the appraisal
 * pipeline has changed.
 *
 * Skipped by default. Run with:
 *   npx vitest run tests/judgement-scenario.test.ts --reporter=verbose
 * Remove `.skip` to enable.
 */

import { describe, it } from "vitest";
import { appraiseLot } from "../src/engine/auction/bidder-profile.js";
import { createRNG } from "../src/engine/core/rng.js";
import type { AuctionLot } from "../src/engine/auction/types.js";
import type { BidderProfile } from "../src/engine/auction/bidder-profile.js";

const TRUE_LOT_VALUE = 100;
const J_VALUES = [0.10, 0.12, 0.30, 0.50, 0.80];
const FLOOR_SCENARIOS = [60, 85, 100, 115];
const TRIALS = 5000;

function makeProfile(j: number): BidderProfile {
  return {
    appraisalAccuracy: new Map(),
    defaultAppraisalAccuracy: j,
    flawTypeDetection: new Map(),
    defaultFlawTypeDetection: 0.5,
  };
}

const lot: AuctionLot = {
  id: 1,
  sourcePoolId: null,
  itemKindId: 1,
  qualityTier: "fair",
  quantity: 1,
  floorPrice: 0,
  listedDay: 1,
  scheduledHour: null,
  clearedDay: null,
  clearedPrice: null,
  clearedToActorId: null,
  provenance: null,
};

describe.skip("judgement scenario (exploratory, no assertions)", () => {
  it("tabulates appraiseLot behaviour across j values", () => {
    console.log(
      `\nTrue lot value: £${TRUE_LOT_VALUE} | RNG: deterministic, ${TRIALS} trials per j\n`,
    );

    // ── Bid distribution table ────────────────────────────────────────
    console.log("Bid valuation distribution (per bidder, in isolation):");
    console.log(
      "  j     | analytic range | mean   | sd    | p10    | p50    | p90    ",
    );
    console.log(
      "  ------+----------------+--------+-------+--------+--------+--------",
    );
    type Sample = { j: number; samples: number[] };
    const allSamples: Sample[] = [];
    for (const j of J_VALUES) {
      const profile = makeProfile(j);
      const rng = createRNG(`judgement-j${j}`);
      const samples: number[] = [];
      for (let i = 0; i < TRIALS; i += 1) {
        const r = appraiseLot({
          profile,
          lot,
          category: "electrical",
          flawType: null,
          trueLotValue: TRUE_LOT_VALUE,
          rng,
        });
        samples.push(r.valuation);
      }
      samples.sort((a, b) => a - b);
      const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
      const variance =
        samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length;
      const sd = Math.sqrt(variance);
      const p = (q: number) => samples[Math.floor(samples.length * q)] ?? 0;
      const analyticMin = Math.max(0, TRUE_LOT_VALUE * j);
      const analyticMax = TRUE_LOT_VALUE * (2 - j);
      console.log(
        `  ${j.toFixed(2)}  | £${String(analyticMin).padStart(3)}–£${String(analyticMax).padStart(3)}     ` +
          `| £${mean.toFixed(0).padStart(4)} ` +
          `| £${sd.toFixed(0).padStart(3)}  ` +
          `| £${String(p(0.1)).padStart(4)}  ` +
          `| £${String(p(0.5)).padStart(4)}  ` +
          `| £${String(p(0.9)).padStart(4)}`,
      );
      allSamples.push({ j, samples });
    }

    // ── P(bid) at each floor ─────────────────────────────────────────
    console.log("\nP(bid at all) — bidder bids iff valuation > floor:");
    const floorHeader = FLOOR_SCENARIOS.map((f) => `£${String(f).padStart(3)}`).join(" | ");
    console.log(`  j     | ${floorHeader}`);
    console.log(`  ------+${"-".repeat(floorHeader.length + 2)}`);
    for (const { j, samples } of allSamples) {
      const row = FLOOR_SCENARIOS.map((floor) => {
        const bidders = samples.filter((v) => v > floor).length;
        return `${((bidders / samples.length) * 100).toFixed(0).padStart(3)}%`;
      }).join(" | ");
      console.log(`  ${j.toFixed(2)}  | ${row}`);
    }

    // ── Head-to-head — all 5 bid on the same lot ──────────────────────
    console.log(
      "\nHead-to-head: 5 bidders, same lot, true value £100, floor £85, 10 rounds:",
    );
    console.log("  round | " + J_VALUES.map((j) => `j=${j.toFixed(2)}`).join(" | ") + " | winner");
    console.log("  ------+" + "-".repeat(56));
    const headRng = J_VALUES.map((j) => ({
      j,
      profile: makeProfile(j),
      rng: createRNG(`head-${j}`),
    }));
    for (let round = 1; round <= 10; round += 1) {
      const bids: { j: number; valuation: number }[] = [];
      for (const b of headRng) {
        const r = appraiseLot({
          profile: b.profile,
          lot,
          category: "electrical",
          flawType: null,
          trueLotValue: TRUE_LOT_VALUE,
          rng: b.rng,
        });
        bids.push({ j: b.j, valuation: r.valuation });
      }
      const above = bids.filter((b) => b.valuation > 85);
      const winner =
        above.length === 0
          ? "(no bid)"
          : `j=${above.reduce((best, b) => (b.valuation > best.valuation ? b : best)).j.toFixed(2)}`;
      const cells = bids
        .map((b) => (b.valuation > 85 ? `£${String(b.valuation).padStart(4)}` : "  —  "))
        .join(" | ");
      console.log(`  ${String(round).padStart(5)} | ${cells} | ${winner}`);
    }

    // ── Stepped-j (proposed band model, no sub-band sharpness) ───────
    console.log(
      "\nUnder proposed stepped-j model — effective_accuracy = floor(j×10)/10:",
    );
    console.log("  j     | effective | analytic range");
    console.log("  ------+-----------+----------------");
    for (const j of J_VALUES) {
      const effective = Math.floor(j * 10) / 10;
      const min = Math.max(0, TRUE_LOT_VALUE * effective);
      const max = TRUE_LOT_VALUE * (2 - effective);
      console.log(
        `  ${j.toFixed(2)}  |   ${effective.toFixed(2)}    | £${String(min).padStart(3)}–£${String(max).padStart(3)}`,
      );
    }
    console.log(
      "\nUnder stepped+sharpness — effective = floor(j×10)/10 + frac(j×10)×0.1:",
    );
    console.log("  j     | bands | sharp | effective | analytic range");
    console.log("  ------+-------+-------+-----------+----------------");
    for (const j of J_VALUES) {
      const bands = Math.max(1, Math.floor(j * 10));
      const sharp = j * 10 - Math.floor(j * 10);
      const effective = Math.floor(j * 10) / 10 + sharp * 0.1;
      const min = Math.max(0, TRUE_LOT_VALUE * effective);
      const max = TRUE_LOT_VALUE * (2 - effective);
      console.log(
        `  ${j.toFixed(2)}  |  ${bands}    |  ${sharp.toFixed(2)} |   ${effective.toFixed(3)}   | £${String(min.toFixed(0)).padStart(3)}–£${String(max.toFixed(0)).padStart(3)}`,
      );
    }
  });
});
