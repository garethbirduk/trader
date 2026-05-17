import type { DB } from "../core/db.js";

/**
 * Judgement audit trail (docs/judgement.md — "Judgement audit trail
 * + hover-over math in the UI"). Persists every judgement-engine
 * call that drove a player-visible action so the UI can surface the
 * math retrospectively without re-deriving it.
 *
 * Two payload shapes, discriminated by `record.arm`:
 *   • `price` — `estimate`/`estimatePriceBand` (sample optional —
 *     RNG-free `estimatePriceBand` calls omit it).
 *   • `composite` — `estimateLotValue` (Condition ∘ Price chain plus
 *     flaw, character-arm bonus, customer-fit). Carries the per-arm
 *     breakdown the UI needs for the decomposition view.
 *
 * Call sites populate the payload themselves and call
 * `insertJudgement`. The engine functions stay pure — they return
 * the math; the call site decides whether to persist it.
 */

export type JudgementArm = "price" | "condition" | "composite";

/** What player-visible decision this judgement informed. Indexed
 *  with `context_ref_id` so the UI can join from an event back to
 *  the audit row. Names are stable strings; widen the set with each
 *  call-site instrumentation. */
export type JudgementContextKind =
  | "auction-bid"
  | "pubdeal-appraisal"
  | "market-seller-belief"
  | "shop-seller-belief"
  | "lead-seed";

/** Price-arm payload — `estimate`/`estimatePriceBand` result plus the
 *  inputs needed to reconstruct the formula in the UI. `sample` is
 *  optional because `estimatePriceBand` (RNG-free) returns only the
 *  band centre and bounds, no draw. */
export interface PriceArmPayload {
  readonly itemKindId: number;
  readonly category: string;
  /** Tier the band was computed against — drives the truth
   *  multiplier. Nullable for surfaces that don't carry a tier
   *  read (rare; mostly composite-internal price calls). */
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
  /** Quantity context — `lot.quantity`, lead quantity, etc. When
   *  the caller has a meaningful per-unit-vs-total framing.
   *  Optional; the formatter falls back to "per unit" only. */
  readonly quantity: number | null;
}

/** Composite payload — `estimateLotValue` result decomposed into its
 *  contributing arms. `condition` is nullable because the auction's
 *  uninspected path passes `perceivedTierOverride` and skips the
 *  condition arm entirely; the override case sets `overridden: true`
 *  and `condition: null` for that detail. */
export interface CompositePayload {
  readonly itemKindId: number;
  readonly category: string;
  readonly quantity: number;
  readonly truthTier: string;
  readonly perceivedTier: string;
  /** True when the call site passed `perceivedTierOverride` and the
   *  condition arm didn't run. */
  readonly conditionOverridden: boolean;
  /** Condition arm details — null when overridden. */
  readonly condition: {
    readonly expertise: number;
    readonly j: number;
    readonly anchor: number;
  } | null;
  /** Price arm details — always populated (the price arm always
   *  runs in estimateLotValue). */
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
  /** Flaw + character-arm contribution. `flawDetectionBonus` is the
   *  α × (buyer_social − seller_social) term (see
   *  pub-deal-autonomy.ts). 0 outside pub-deal contexts. */
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

export type JudgementPayload = PriceArmPayload | CompositePayload;

export interface JudgementRecord {
  readonly id: number;
  readonly day: number;
  readonly hour: number;
  readonly actorId: number;
  readonly arm: JudgementArm;
  readonly contextKind: JudgementContextKind;
  readonly contextRefId: number | null;
  readonly payload: JudgementPayload;
}

export interface InsertJudgementArgs {
  readonly day: number;
  readonly hour: number;
  readonly actorId: number;
  readonly arm: JudgementArm;
  readonly contextKind: JudgementContextKind;
  readonly contextRefId: number | null;
  readonly payload: JudgementPayload;
}

interface Row {
  id: number;
  day: number;
  hour: number;
  actor_id: number;
  arm: string;
  context_kind: string;
  context_ref_id: number | null;
  payload: string;
}

function rowTo(row: Row): JudgementRecord {
  if (row.arm !== "price" && row.arm !== "condition" && row.arm !== "composite") {
    throw new Error(`judgement_log: invalid arm '${row.arm}'`);
  }
  return {
    id: row.id,
    day: row.day,
    hour: row.hour,
    actorId: row.actor_id,
    arm: row.arm,
    contextKind: row.context_kind as JudgementContextKind,
    contextRefId: row.context_ref_id,
    payload: JSON.parse(row.payload) as JudgementPayload,
  };
}

export function insertJudgement(db: DB, args: InsertJudgementArgs): number {
  const result = db
    .prepare(
      `INSERT INTO judgement_log
         (day, hour, actor_id, arm, context_kind, context_ref_id, payload)
       VALUES (@day, @hour, @actor, @arm, @ctxKind, @ctxRef, @payload)`,
    )
    .run({
      day: args.day,
      hour: args.hour,
      actor: args.actorId,
      arm: args.arm,
      ctxKind: args.contextKind,
      ctxRef: args.contextRefId,
      payload: JSON.stringify(args.payload),
    });
  return Number(result.lastInsertRowid);
}

export function getJudgementById(db: DB, id: number): JudgementRecord | null {
  const row = db
    .prepare<Row>(`SELECT * FROM judgement_log WHERE id = @id`)
    .get({ id });
  return row ? rowTo(row) : null;
}

export function listJudgementsByDay(db: DB, day: number): JudgementRecord[] {
  return db
    .prepare<Row>(
      `SELECT * FROM judgement_log
       WHERE day = @day
       ORDER BY hour, id`,
    )
    .all({ day })
    .map(rowTo);
}

export function listJudgementsByActorDay(
  db: DB,
  actorId: number,
  day: number,
): JudgementRecord[] {
  return db
    .prepare<Row>(
      `SELECT * FROM judgement_log
       WHERE actor_id = @actor AND day = @day
       ORDER BY hour, id`,
    )
    .all({ actor: actorId, day })
    .map(rowTo);
}

export function getJudgementByContextRef(
  db: DB,
  contextKind: JudgementContextKind,
  contextRefId: number,
): JudgementRecord | null {
  const row = db
    .prepare<Row>(
      `SELECT * FROM judgement_log
       WHERE context_kind = @kind AND context_ref_id = @ref
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get({ kind: contextKind, ref: contextRefId });
  return row ? rowTo(row) : null;
}

/** Drop rows older than `keepDays` days from the current day.
 *  Retention housekeeper — call from a daily-end hook with the
 *  configured retention. Returns the row count deleted. */
export function pruneJudgementsOlderThan(
  db: DB,
  currentDay: number,
  keepDays: number,
): number {
  const cutoff = currentDay - keepDays;
  if (cutoff < 0) return 0;
  const result = db
    .prepare(`DELETE FROM judgement_log WHERE day < @cutoff`)
    .run({ cutoff });
  return Number(result.changes);
}
