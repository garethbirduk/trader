import type { DB } from "../core/db.js";
import type { Clock } from "../core/clock.js";
import type { EventLog } from "../core/events.js";
import { adjustActorCash, getActorById } from "../actors/actors-repo.js";
import { seedWitnessLeads } from "../witness/seed-witness-leads.js";

/**
 * Bribe primitive (todolist #4).
 *
 * Three outcomes:
 *   "accepted" — officer is bribable and amount >= threshold. Cash
 *                transfers, witness leads fire (the bribe is a
 *                notable event), event emitted.
 *   "refused"  — officer is not bribable, OR amount < threshold.
 *                Event emitted with refusal reason. No cash moves.
 *   "blocked"  — offerer can't afford the amount, or invalid args.
 *
 * Threshold model: each bribable officer has a base threshold that
 * scales with their existing cash (the richer they are, the higher
 * the bribe needs to be — they don't need pocket-money). The
 * caller passes `baseThreshold`; the effective threshold is
 * `baseThreshold * (1 + officerCash / cashSensitivityScalar)`.
 */

export interface OfferBribeArgs {
  readonly offererActorId: number;
  readonly officerActorId: number;
  readonly amount: number;
  /** Base bribe threshold — minimum offer the officer will consider
   *  before cash-position adjustment. */
  readonly baseThreshold: number;
  /** Scales the bribed-officer-getting-richer-needs-more curve.
   *  Higher = officer's appetite grows more slowly with their wealth.
   *  Default 1000 — at £1000 cash the threshold doubles. */
  readonly cashSensitivityScalar?: number;
  /** Venue, used for witness-lead seeding. Bribe witnesses get a
   *  rep-lead about both principals. */
  readonly locationId: number;
  readonly atDay: number;
  /** Optional event log. When supplied, bribe.offered / bribe.accepted
   *  / bribe.refused events fire. */
  readonly events?: EventLog;
  /** Context tag for the witness-lead's subject_event_type. Defaults
   *  to "bribe" — callers can refine (e.g. "bribe-bust-waiver"). */
  readonly eventTag?: string;
  /** Free-form context attached to witness leads — bust scenario,
   *  item under bust, etc. */
  readonly context?: Record<string, unknown>;
}

export type OfferBribeResult =
  | {
      readonly type: "accepted";
      readonly amount: number;
      readonly thresholdAtTime: number;
    }
  | {
      readonly type: "refused";
      readonly reason: "not-bribable" | "below-threshold";
      readonly thresholdAtTime: number;
    }
  | {
      readonly type: "blocked";
      readonly reason: string;
    };

export function offerBribe(
  db: DB,
  clock: Clock,
  args: OfferBribeArgs,
): OfferBribeResult {
  if (args.amount <= 0) {
    return { type: "blocked", reason: `amount must be > 0; got ${args.amount}` };
  }
  if (args.offererActorId === args.officerActorId) {
    return { type: "blocked", reason: "cannot bribe yourself" };
  }
  return db.transaction((): OfferBribeResult => {
    const offerer = getActorById(db, args.offererActorId);
    if (!offerer) return { type: "blocked", reason: "offerer not found" };
    if (offerer.cash < args.amount) {
      return {
        type: "blocked",
        reason: `offerer cash £${offerer.cash} < amount £${args.amount}`,
      };
    }
    const officer = getActorById(db, args.officerActorId);
    if (!officer) return { type: "blocked", reason: "officer not found" };

    const scalar = args.cashSensitivityScalar ?? 1000;
    const thresholdAtTime = Math.round(
      args.baseThreshold * (1 + officer.cash / scalar),
    );

    args.events?.emit({
      type: "bribe.offered",
      at: clock,
      offererActorId: args.offererActorId,
      officerActorId: args.officerActorId,
      amount: args.amount,
      thresholdAtTime,
      locationId: args.locationId,
    });

    if (!officer.bribable) {
      args.events?.emit({
        type: "bribe.refused",
        at: clock,
        offererActorId: args.offererActorId,
        officerActorId: args.officerActorId,
        amount: args.amount,
        reason: "not-bribable",
        locationId: args.locationId,
      });
      return {
        type: "refused",
        reason: "not-bribable",
        thresholdAtTime,
      };
    }
    if (args.amount < thresholdAtTime) {
      args.events?.emit({
        type: "bribe.refused",
        at: clock,
        offererActorId: args.offererActorId,
        officerActorId: args.officerActorId,
        amount: args.amount,
        reason: "below-threshold",
        locationId: args.locationId,
      });
      return {
        type: "refused",
        reason: "below-threshold",
        thresholdAtTime,
      };
    }

    // Accepted. Cash transfers to the officer personally — design
    // point: bribes flow off the off-map ledger into the bribed cop's
    // own pocket.
    adjustActorCash(db, args.offererActorId, -args.amount);
    adjustActorCash(db, args.officerActorId, args.amount);
    args.events?.emit({
      type: "bribe.accepted",
      at: clock,
      offererActorId: args.offererActorId,
      officerActorId: args.officerActorId,
      amount: args.amount,
      thresholdAtTime,
      locationId: args.locationId,
    });
    // Witness-lead seeding — present bystanders see the exchange.
    // The lead carries both principals (offerer = subject_target,
    // officer = counterparty) and the amount + context payload.
    seedWitnessLeads(db, {
      locationId: args.locationId,
      principalActorId: args.offererActorId,
      counterpartyActorId: args.officerActorId,
      eventType: args.eventTag ?? "bribe",
      ...(args.context !== undefined ? { context: args.context } : {}),
      amount: args.amount,
      atDay: args.atDay,
    });
    return { type: "accepted", amount: args.amount, thresholdAtTime };
  });
}
