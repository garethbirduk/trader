/**
 * Standard auction bid-step ladder. Real-world auction houses (Sotheby's,
 * Christie's, eBay) use a non-linear increment schedule where the step
 * grows with the bid: £1 steps below £10, £2 steps to £20, £5 to £50,
 * £10 to £100, £25 to £200, and so on. The result is a discrete set of
 * legal bid amounts; bids must land on a rung, never between.
 *
 * The engine uses this for resolving auction sessions: the winner pays
 * the smallest rung strictly above the runner-up's snapped ceiling,
 * capped at their own ceiling.
 */

interface Band {
  readonly from: number;
  readonly to: number;
  readonly step: number;
}

const BANDS: readonly Band[] = [
  { from: 1,       to: 8,        step: 1 },
  { from: 10,      to: 20,       step: 2 },
  { from: 25,      to: 50,       step: 5 },
  { from: 60,      to: 100,      step: 10 },
  { from: 125,     to: 200,      step: 25 },
  { from: 250,     to: 500,      step: 50 },
  { from: 600,     to: 1_000,    step: 100 },
  { from: 1_250,   to: 2_000,    step: 250 },
  { from: 2_500,   to: 5_000,    step: 500 },
  { from: 6_000,   to: 10_000,   step: 1_000 },
  { from: 12_500,  to: 20_000,   step: 2_500 },
  { from: 25_000,  to: 50_000,   step: 5_000 },
  { from: 60_000,  to: 100_000,  step: 10_000 },
  { from: 125_000, to: 200_000,  step: 25_000 },
  { from: 250_000, to: 500_000,  step: 50_000 },
  { from: 600_000, to: 1_000_000, step: 100_000 },
];

/** Beyond £1M, continue stepping by this amount (extrapolation). */
const TAIL_STEP = 100_000;

export const BID_LADDER: readonly number[] = (() => {
  const rungs: number[] = [];
  for (const b of BANDS) {
    for (let v = b.from; v <= b.to; v += b.step) rungs.push(v);
  }
  return rungs;
})();

/** Smallest ladder rung strictly greater than `amount`. */
export function nextRungAbove(amount: number): number {
  for (const r of BID_LADDER) {
    if (r > amount) return r;
  }
  const top = BID_LADDER[BID_LADDER.length - 1]!;
  const stepsAbove = Math.floor((amount - top) / TAIL_STEP) + 1;
  return top + stepsAbove * TAIL_STEP;
}

/** Highest ladder rung at or below `amount`. Returns 0 if `amount` < first rung. */
export function rungAtOrBelow(amount: number): number {
  if (amount < BID_LADDER[0]!) return 0;
  let last = 0;
  for (const r of BID_LADDER) {
    if (r > amount) return last;
    last = r;
  }
  // Above the table — extrapolate downward in TAIL_STEP units.
  const top = BID_LADDER[BID_LADDER.length - 1]!;
  const stepsAbove = Math.floor((amount - top) / TAIL_STEP);
  return top + stepsAbove * TAIL_STEP;
}

/** Smallest ladder rung at or above `amount`. */
export function rungAtOrAbove(amount: number): number {
  if (amount <= BID_LADDER[0]!) return BID_LADDER[0]!;
  for (const r of BID_LADDER) {
    if (r >= amount) return r;
  }
  return nextRungAbove(BID_LADDER[BID_LADDER.length - 1]!);
}
