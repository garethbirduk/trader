import type { RunDump } from "../types.js";

export interface AuctionWindow {
  readonly start: number;
  readonly end: number;
}

/**
 * Resolve the auction window from a dump. New dumps carry
 * `auctionStartHour` / `auctionEndHour` (one lot per hour over a
 * window). Older dumps carry only the legacy single-hour `auctionHour`,
 * which we treat as a one-hour window. Returns null when the dump has
 * neither — the auction simply doesn't run.
 */
export function resolveAuctionWindow(
  dump: Pick<RunDump, "auctionStartHour" | "auctionEndHour" | "auctionHour">,
): AuctionWindow | null {
  if (
    dump.auctionStartHour !== undefined &&
    dump.auctionEndHour !== undefined
  ) {
    return { start: dump.auctionStartHour, end: dump.auctionEndHour };
  }
  if (dump.auctionHour !== undefined) {
    return { start: dump.auctionHour, end: dump.auctionHour };
  }
  return null;
}

export function isHourInAuctionWindow(
  dump: Pick<RunDump, "auctionStartHour" | "auctionEndHour" | "auctionHour">,
  hour: number,
): boolean {
  const w = resolveAuctionWindow(dump);
  if (w === null) return false;
  return hour >= w.start && hour <= w.end;
}
