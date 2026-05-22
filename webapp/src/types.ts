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

/** Mirrors the engine's `JudgementRecord` (src/engine/perception/
 *  judgement-log-repo.ts). Carried on the dump so the UI can look
 *  up "the math behind this decision" by (actorId, contextKind,
 *  contextRefId) without re-deriving from primitives. Payload shape
 *  matches `JudgementPayload` — `price` (PriceArmPayload) or
 *  `composite` (CompositePayload) discriminated by `arm`. Kept
 *  loose here so type drift between engine and webapp can't break
 *  dump-loading. */
export interface RunJudgement {
  readonly id: number;
  readonly day: number;
  readonly hour: number;
  readonly actorId: number;
  readonly arm: "price" | "condition" | "composite";
  readonly contextKind: string;
  readonly contextRefId: number | null;
  readonly payload: unknown;
}

/** Price-arm payload — what `estimate` / `estimatePriceBand`
 *  produced plus the inputs needed to reconstruct the formula. */
export interface PriceArmPayload {
  readonly itemKindId: number;
  readonly category: string;
  readonly truthTier: string | null;
  readonly truthUnit: number;
  readonly anchor: number;
  readonly tierMultiplier: number | null;
  readonly expertise: number;
  readonly j: number;
  readonly centre: number;
  readonly low: number;
  readonly high: number;
  readonly sample: number | null;
  readonly quantity: number | null;
}

/** Composite payload — `estimateLotValue` decomposed. */
export interface CompositePayload {
  readonly itemKindId: number;
  readonly category: string;
  readonly quantity: number;
  readonly truthTier: string;
  readonly perceivedTier: string;
  readonly conditionOverridden: boolean;
  readonly condition: {
    readonly expertise: number;
    readonly j: number;
    readonly anchor: number;
  } | null;
  readonly price: {
    readonly truthUnit: number;
    readonly anchor: number;
    readonly tierMultiplier: number;
    readonly expertise: number;
    readonly j: number;
    readonly centre: number;
    readonly low: number;
    readonly high: number;
    readonly sample: number;
  };
  readonly flaw: {
    readonly itemFlawType: string | null;
    readonly knownFlawType: string | null;
    readonly detected: boolean;
    readonly multiplier: number;
    readonly detectionBonus: number;
  };
  readonly customerFitMultiplier: number;
  readonly perceivedUnitValue: number;
  readonly perceivedLotValue: number;
}

export interface RunActor {
  readonly id: number;
  readonly code: string;
  /** Given name. Required in new dumps; absent in legacy events.json
   *  files generated before the rename. UI helpers fall back via
   *  `displayName` when missing. */
  readonly firstName?: string;
  /** Family name. Null for institutions / one-name characters; absent
   *  in legacy dumps. */
  readonly lastName?: string | null;
  /** Chip-friendly nickname or short label. Required in new dumps;
   *  optional here so older events.json files still load. */
  readonly shortName?: string;
  /** Composed full display name. Kept for back-compat — UI helpers
   *  fall back to this when the structured fields are absent. */
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
  readonly knowledgeProfile?: KnowledgeProfileDump;
  /** Per-arm j overrides from the engine's `actor_arm_j` table —
   *  surfaces "stored j != expertise" cases (decisive-but-wrong or
   *  hesitant-but-right characters). Missing arms fall back to the
   *  actor's expertise for that arm (skin default). Optional for
   *  back-compat with dumps generated before the arm-j surface
   *  shipped through the dump. */
  readonly armJ?: Partial<Record<"condition" | "price" | "character", number>>;
}

export interface KnowledgeProfileDump {
  readonly bandPlacementAccuracy: Readonly<Record<string, number>>;
  readonly defaultBandPlacementAccuracy: number;
  readonly conditionAccuracy: Readonly<Record<string, number>>;
  readonly defaultConditionAccuracy: number;
  readonly flawDetection: Readonly<Record<string, number>>;
  readonly defaultFlawDetection: number;
  readonly priceAccuracy: Readonly<Record<string, number>>;
  readonly defaultPriceAccuracy: number;
  readonly customerFitAccuracy: Readonly<Record<string, number>>;
  readonly defaultCustomerFitAccuracy: number;
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
  /** Hours where the actor's routine just falls back to home — not a
   *  "fixed" job slot but a placeholder the engine fills with ad-hoc
   *  moves. Calendar-knowledge derivation reads this so a third party
   *  who "knows" the actor's routine doesn't infer false certainty
   *  about flex-hour locations. Optional for back-compat. */
  readonly flexibleHours?: readonly number[];
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
  /** Pairs of actors whose calendars are implicitly shared (close family,
   *  business partners). Each pair-member always "knows" their partner's
   *  actual location. Optional for back-compat with older dumps. */
  readonly pairs?: readonly (readonly [number, number])[];
  readonly playerActorId: number;
  readonly auctionHouseActorId: number;
  readonly auctionLocationId?: number;
  /** Subset of the engine's economics config that the webapp needs to
   *  reproduce retail estimates and ceilings client-side. Optional for
   *  older dumps. */
  readonly economics?: EconomicsDump;
  /** Per-category anchor table — the "uninformed prior" floor of the
   *  judgement engine's `centre = anchor + (truth - anchor) × expertise`
   *  lerp. Used by StockChip to render perceiver-relative belief bands
   *  client-side. Optional for older dumps. */
  readonly categoryAnchors?: Readonly<Record<string, number>>;
  /** Per-category condition-arm anchor in [0, 1] — the analogous prior
   *  for perceived condition. Future webapp surfaces that want to show
   *  "what tier would this actor expect by default in this category?"
   *  read it via `conditionAnchorFor(dump, category)`. Optional for
   *  older dumps. */
  readonly categoryConditionAnchors?: Readonly<Record<string, number>>;
  /** Judgement audit trail (docs/judgement.md — "Judgement audit
   *  trail"). One row per judgement-engine call that drove a
   *  player-visible action: auction bid ceiling, pubdeal appraisal,
   *  market/shop sellerBelief, lead-seeder propagated band. The
   *  webapp indexes by (actorId, contextKind, contextRefId) via
   *  `lib/judgement-log.ts` to find "the math behind this event"
   *  without a DB roundtrip. Optional for older dumps. */
  readonly judgements?: readonly RunJudgement[];
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
