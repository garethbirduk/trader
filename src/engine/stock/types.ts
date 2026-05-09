/**
 * Quality tiers for stock lots. Ordered from best to worst. The whole
 * "buy 100, only 10 are mint, 90 are shoddy" mechanic lives on this axis,
 * so the engine treats each tier as a distinct sub-stack rather than
 * averaging over a continuous quality score.
 */
export const QUALITY_TIERS = ["mint", "good", "fair", "shoddy", "broken"] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];

export function isQualityTier(value: unknown): value is QualityTier {
  return typeof value === "string" && (QUALITY_TIERS as readonly string[]).includes(value);
}

/**
 * Physical-size category — drives the transport tier required to move
 * a unit. Per the design:
 *
 *   • small  — fits in a pocket. Movable by anyone, anywhere.
 *   • mid    — fits in a car boot. Needs at least 'boot' transport.
 *   • large  — needs a van or truck.
 */
export const ITEM_SIZES = ["small", "mid", "large"] as const;
export type ItemSize = (typeof ITEM_SIZES)[number];

export function isItemSize(value: unknown): value is ItemSize {
  return typeof value === "string" && (ITEM_SIZES as readonly string[]).includes(value);
}

export const FLAW_TYPES = [
  "faulty",
  "stolen",
  "scam_bait",
  "fake",
  "wrong_season",
  "wrong_market",
  "dangerous",
] as const;
export type FlawType = (typeof FLAW_TYPES)[number];

export function isFlawType(value: unknown): value is FlawType {
  return typeof value === "string" && (FLAW_TYPES as readonly string[]).includes(value);
}

export interface ItemKind {
  readonly id: number;
  readonly code: string;
  readonly displayName: string;
  readonly category: string;
  readonly baseValue: number;
  readonly flawType: FlawType | null;
  readonly risk: number;
  readonly targetCustomers: readonly string[];
  readonly isEasterEgg: boolean;
  readonly flavourText: string | null;
  readonly spawnWeight: number;
  readonly size: ItemSize;
}

export interface StockLot {
  readonly id: number;
  readonly ownerActorId: number;
  readonly itemKindId: number;
  readonly qualityTier: QualityTier;
  readonly quantity: number;
  readonly acquiredUnitPrice: number;
  readonly acquiredDay: number;
  /**
   * Where this batch physically sits. Independent of the owner's body
   * — a dealer can be at the pub while their goods stay in the lock-up.
   * Null for rows that pre-date the location split (legacy / tests).
   */
  readonly locationId: number | null;
}
