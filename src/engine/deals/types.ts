import type { QualityTier } from "../stock/types.js";

export const DEAL_STATES = [
  "proposed",
  "agreed",
  "settled",
  "defaulted",
  "cancelled",
] as const;
export type DealState = (typeof DEAL_STATES)[number];

export function isDealState(value: unknown): value is DealState {
  return typeof value === "string" && (DEAL_STATES as readonly string[]).includes(value);
}

export interface DealLine {
  readonly id: number;
  readonly dealId: number;
  readonly itemKindId: number;
  readonly qualityTier: QualityTier;
  readonly quantity: number;
  readonly unitPrice: number;
}

export interface Deal {
  readonly id: number;
  readonly buyerActorId: number;
  readonly sellerActorId: number;
  readonly state: DealState;
  readonly agreedDay: number;
  readonly deadlineDay: number;
  readonly deliveryLocationId: number | null;
  readonly settledDay: number | null;
  readonly defaultedDay: number | null;
  readonly defaultReason: string | null;
  readonly notes: string | null;
  /** Day the seller physically dispatched the goods (Phase 2). */
  readonly deliveryDispatchedDay: number | null;
}

export function totalPriceOfLines(lines: readonly DealLine[]): number {
  let total = 0;
  for (const line of lines) total += line.quantity * line.unitPrice;
  return total;
}
