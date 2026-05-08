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
}

export interface RunActorRoutine {
  readonly actorId: number;
  readonly homeLocationId: number | null;
  readonly schedule: readonly { hour: number; locationId: number }[];
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

export interface RunLocation {
  readonly id: number;
  readonly code: string;
  readonly displayName: string;
  readonly type?: LocationType;
  readonly openHours?: { start: number; end: number } | null;
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
  readonly clearedDay: number | null;
  readonly clearedPrice: number | null;
  readonly clearedToActorId: number | null;
}

export interface DaySnapshot {
  readonly day: number;
  readonly actors: readonly SnapshotActor[];
  readonly stockLots: readonly SnapshotStockLot[];
  readonly deals: readonly SnapshotDeal[];
  readonly pools: readonly SnapshotPool[];
  readonly auctionLots: readonly SnapshotAuctionLot[];
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
  readonly auctionHour?: number;
}
