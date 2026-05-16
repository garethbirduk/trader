// Mirrors the JSON shape produced by `npm run sim -- --out events.json`.
// The webapp doesn't import engine types directly so it can stay
// decoupled from the engine's TypeScript build.

export interface ClockStamp {
  readonly day: number;
  readonly hour: number;
}

export interface RunEvent {
  readonly type: string;
  readonly at: ClockStamp;
  // Other fields vary by event type; we treat them as unknown structured
  // data and let the renderers pick what they care about.
  readonly [key: string]: unknown;
}

export interface RunActor {
  readonly id: number;
  readonly code: string;
  readonly displayName: string;
  readonly cash: number;
  readonly currentLocationId: number | null;
  readonly homeLocationId: number | null;
  readonly transportCapacity: string;
  /** Descriptive tags ("dealer", "civilian", "police", …). Optional
   *  so dumps generated before this field still load. */
  readonly roles?: readonly string[];
  /** Stage 6 — named external producer/consumer. They don't have a
   *  routine, location, or any in-world position. Optional for
   *  back-compat with older dumps. */
  readonly isVirtual?: boolean;
  /** Character-arm scalar in [0, 1] — drives the bidirectional read
   *  at pub-deal entry (docs/judgement.md). Optional for back-compat
   *  with dumps generated before the character arm shipped. */
  readonly socialScore?: number;
  /** Bidder profile snapshot — used to compute retail estimates. */
  readonly bidderProfile?: BidderProfileDump;
}

export interface BidderProfileDump {
  readonly appraisalAccuracy: Readonly<Record<string, number>>;
  readonly defaultAppraisalAccuracy: number;
  readonly flawTypeDetection: Readonly<Record<string, number>>;
  readonly defaultFlawTypeDetection: number;
  readonly customerTypes: readonly string[];
}

export interface EconomicsDump {
  readonly tierMultipliers: Readonly<Record<string, number>>;
  readonly estimateSpreadAtZeroAccuracy: number;
  readonly estimateSpreadAtFullAccuracy: number;
  readonly pubBuyerCeilingFraction: number;
}

export interface RunActorRoutine {
  readonly actorId: number;
  readonly homeLocationId: number | null;
  readonly schedule: readonly { hour: number; locationId: number }[];
  /** Optional weekend (Sat/Sun) schedule. When present, the diary uses
   *  it for weekend days instead of the weekday `schedule`. Fixed-job
   *  actors whose venue closes on weekends ship one of these. */
  readonly weekendSchedule?: readonly { hour: number; locationId: number }[];
  readonly awakeHours: { start: number; end: number };
}

export interface RunItem {
  readonly id: number;
  readonly code: string;
  readonly displayName: string;
  readonly category: string;
  readonly baseValue: number;
  readonly flawType: string | null;
  readonly risk: number;
  readonly isEasterEgg: boolean;
  readonly flavourText: string | null;
}

export type LocationType =
  | "home"
  | "business"
  | "pub"
  | "auction"
  | "civic"
  | "street"
  | "abstract";

export interface RunOpenSession {
  readonly daysOfWeek: readonly number[];
  readonly start: number;
  readonly end: number;
}

export interface RunLocation {
  readonly id: number;
  readonly code: string;
  readonly displayName: string;
  readonly type?: LocationType;
  readonly openHours?: { start: number; end: number } | null;
  /** Day-aware schedule. Multiple sessions, each applying to a set of
   *  weekdays. `end > 24` means the session wraps past midnight. When
   *  set, this is the canonical schedule for visual open/closed. */
  readonly openSessions?: readonly RunOpenSession[];
}

export interface RunTally {
  readonly poolFlushed: number;
  readonly poolClaimed: number;
  readonly auctionCleared: number;
  readonly auctionUnsold: number;
  readonly dealsSettled: number;
  readonly dealsDefaulted: number;
  readonly pubdealsAttempted: number;
  readonly pubdealsAgreed: number;
  readonly pubdealsWalked: number;
}

export interface SnapshotActor {
  readonly id: number;
  readonly cash: number;
  readonly currentLocationId: number | null;
  readonly heat: number;
  /** Auction lot ids the actor has learned about. Optional for older
   *  dumps. */
  readonly knownAuctionLotIds?: readonly number[];
  /** Auction lot ids the actor has personally inspected. Optional for
   *  older dumps. */
  readonly inspectedAuctionLotIds?: readonly number[];
}

export interface SnapshotStockLot {
  readonly id: number;
  readonly ownerActorId: number;
  readonly itemKindId: number;
  readonly qualityTier: string;
  readonly quantity: number;
  readonly acquiredUnitPrice: number;
  readonly acquiredDay: number;
  readonly locationId: number | null;
}

export interface SnapshotDealLine {
  readonly itemKindId: number;
  readonly qualityTier: string;
  readonly quantity: number;
  readonly unitPrice: number;
}

export interface SnapshotDeal {
  readonly id: number;
  readonly buyerActorId: number;
  readonly sellerActorId: number;
  readonly state: string;
  readonly agreedDay: number;
  readonly deadlineDay: number;
  readonly deliveryLocationId: number | null;
  readonly settledDay: number | null;
  readonly defaultedDay: number | null;
  readonly defaultReason: string | null;
  readonly totalPrice: number;
  readonly lines: readonly SnapshotDealLine[];
}

export interface SnapshotPool {
  readonly id: number;
  readonly itemKindId: number;
  readonly qualityTier: string;
  readonly quantityRemaining: number;
  readonly createdDay: number;
  readonly expiryDay: number;
  readonly openingUnitPrice: number;
  readonly closingUnitPrice: number;
  readonly dumpDestination: string;
  readonly flushedDay: number | null;
  readonly reachableBy: readonly number[];
  /** Stage 6 — named virtual producer behind the pool. Null on ambient
   *  pools. Optional for back-compat with older dumps. */
  readonly ownerActorId?: number | null;
  /** Stage 6 — narrative one-liner ("estate clearance in Bromley"). */
  readonly provenance?: string | null;
}

// Note: floorPrice / clearedPrice are TOTALS (price × qty), per
// migration 007. clearedPrice is null on unsold lots.
export interface SnapshotAuctionLot {
  readonly id: number;
  readonly sourcePoolId: number | null;
  readonly itemKindId: number;
  readonly qualityTier: string;
  readonly quantity: number;
  readonly floorPrice: number;
  readonly listedDay: number;
  /** Hour the engine scheduled this lot for today's running docket
   *  (max one lot per hour, across the auction window). Null when the
   *  lot has never been on the docket. Optional for older dumps. */
  readonly scheduledHour?: number | null;
  readonly clearedDay: number | null;
  readonly clearedPrice: number | null;
  readonly clearedToActorId: number | null;
  /** Stage 7 — narrative tag for regional-clearance lots. */
  readonly provenance?: string | null;
}

export interface SnapshotPendingPayout {
  readonly id: number;
  readonly actorId: number;
  readonly amount: number;
  readonly availableDay: number;
  readonly source: string;
  readonly createdDay: number;
}

export interface SnapshotTrustPair {
  readonly holderActorId: number;
  readonly targetActorId: number;
  readonly score: number;
  readonly lastEventDay: number | null;
}

export interface DaySnapshot {
  readonly day: number;
  readonly actors: readonly SnapshotActor[];
  readonly stockLots: readonly SnapshotStockLot[];
  readonly deals: readonly SnapshotDeal[];
  readonly pools: readonly SnapshotPool[];
  readonly auctionLots: readonly SnapshotAuctionLot[];
  /** Stage 7 — cash-in-transit (lagged off-map resale payouts). */
  readonly pendingPayouts?: readonly SnapshotPendingPayout[];
  /** Trust scores — every pair where score != 0. Powers the
   *  Relations tab. Optional for back-compat with older dumps. */
  readonly trustPairs?: readonly SnapshotTrustPair[];
}

export interface RunDump {
  readonly seed: string;
  readonly runLengthDays: number;
  readonly tally: RunTally;
  readonly events: readonly RunEvent[];
  readonly actors: readonly RunActor[];
  readonly items: readonly RunItem[];
  readonly locations: readonly RunLocation[];
  readonly snapshots: readonly DaySnapshot[];
  readonly actorRoutines?: readonly RunActorRoutine[];
  readonly playerActorId: number;
  readonly auctionHouseActorId: number;
  readonly auctionLocationId?: number;
  /** Subset of the engine's economics config that the webapp needs to
   *  reproduce retail estimates and ceilings client-side. Optional for
   *  older dumps. */
  readonly economics?: EconomicsDump;
  /** Per-category anchor table — the "uninformed prior" floor of the
   *  judgement engine's `centre = anchor + (truth - anchor) × expertise`
   *  lerp. Used by BeliefChip to render perceiver-relative belief bands
   *  client-side. Optional for older dumps. */
  readonly categoryAnchors?: Readonly<Record<string, number>>;
  /** Legacy single-hour auction; replaced by start/end. Older dumps
   *  populate this; newer dumps populate the window pair instead. */
  readonly auctionHour?: number;
  /** First hour of the daily auction window (inclusive). */
  readonly auctionStartHour?: number;
  /** Last hour of the daily auction window (inclusive). One lot per
   *  hour from start..end fires within this range. */
  readonly auctionEndHour?: number;
  /** Where the morning newspaper is published (Sid's Café). */
  readonly newspaperLocationId?: number;
}
