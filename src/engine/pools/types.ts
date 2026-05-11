import type { QualityTier } from "../stock/types.js";

export type DumpDestination = "auction" | "market" | "write_off";

export interface WorldPool {
  readonly id: number;
  readonly itemKindId: number;
  readonly qualityTier: QualityTier;
  readonly quantityRemaining: number;
  readonly createdDay: number;
  readonly expiryDay: number;
  readonly openingUnitPrice: number;
  readonly closingUnitPrice: number;
  readonly dumpDestination: DumpDestination;
  readonly flushedDay: number | null;
  /** Named external producer behind the pool, if any. Null for
   *  ambient pools (no story, no broker gate beyond the legacy
   *  reachability set). */
  readonly ownerActorId: number | null;
  /** One-line narrative attached to the pool: "estate clearance in
   *  Bromley", "fell off a lorry on the A2". Surfaced in the
   *  viewer's pool profile and on supply-lead descriptions. */
  readonly provenance: string | null;
}

/**
 * Linearly interpolate the pool's current unit price between its opening
 * and closing prices. Outside the window, the relevant endpoint is used.
 */
export function poolUnitPriceOnDay(pool: WorldPool, day: number): number {
  if (day <= pool.createdDay) return pool.openingUnitPrice;
  if (day >= pool.expiryDay) return pool.closingUnitPrice;
  const span = pool.expiryDay - pool.createdDay;
  const elapsed = day - pool.createdDay;
  const fraction = elapsed / span;
  return Math.round(
    pool.openingUnitPrice +
      (pool.closingUnitPrice - pool.openingUnitPrice) * fraction,
  );
}
