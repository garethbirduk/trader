import type { DB } from "../core/db.js";
import { isQualityTier, type QualityTier } from "../stock/types.js";
import type { Lead, LeadConfidence, LeadKind, LeadSide } from "./types.js";

export interface InsertLeadInput {
  readonly holderActorId: number;
  /** Discriminator. Defaults to 'commodity' (legacy meaning). */
  readonly kind?: LeadKind;
  readonly side: LeadSide;
  /** Required for commodity leads. Must be omitted/null on rep leads. */
  readonly subjectItemKindId?: number | null;
  readonly subjectQualityTier?: QualityTier | null;
  /** Required for rep leads (the actor the lead is *about*). Must be
   *  omitted/null on commodity leads. */
  readonly subjectTargetActorId?: number | null;
  readonly counterpartyActorId?: number | null;
  readonly estimatedQuantity: number;
  readonly estimatedUnitPrice: number;
  readonly confidence?: LeadConfidence;
  readonly sourceActorId?: number | null;
  readonly acquiredDay: number;
  readonly hopCount?: number;
  readonly derivedFromLeadId?: number | null;
  readonly subjectPoolId?: number | null;
}

interface LeadRow {
  id: number;
  holder_actor_id: number;
  kind: string;
  side: string;
  subject_item_kind_id: number | null;
  subject_quality_tier: string | null;
  subject_target_actor_id: number | null;
  counterparty_actor_id: number | null;
  estimated_qty: number;
  estimated_unit_price: number;
  confidence: string;
  source_actor_id: number | null;
  acquired_day: number;
  hop_count: number;
  derived_from_lead_id: number | null;
  subject_pool_id: number | null;
}

function rowToLead(r: LeadRow): Lead {
  if (r.kind !== "commodity" && r.kind !== "rep") {
    throw new Error(`invalid lead kind: ${r.kind}`);
  }
  if (r.side !== "supply" && r.side !== "demand") {
    throw new Error(`invalid lead side: ${r.side}`);
  }
  if (r.confidence !== "warm" && r.confidence !== "cold") {
    throw new Error(`invalid lead confidence: ${r.confidence}`);
  }
  if (r.subject_quality_tier !== null && !isQualityTier(r.subject_quality_tier)) {
    throw new Error(`invalid quality_tier on lead: ${r.subject_quality_tier}`);
  }
  return {
    id: r.id,
    holderActorId: r.holder_actor_id,
    kind: r.kind,
    side: r.side,
    subjectItemKindId: r.subject_item_kind_id,
    subjectQualityTier: r.subject_quality_tier as QualityTier | null,
    subjectTargetActorId: r.subject_target_actor_id,
    counterpartyActorId: r.counterparty_actor_id,
    estimatedQuantity: r.estimated_qty,
    estimatedUnitPrice: r.estimated_unit_price,
    confidence: r.confidence,
    sourceActorId: r.source_actor_id,
    acquiredDay: r.acquired_day,
    hopCount: r.hop_count,
    derivedFromLeadId: r.derived_from_lead_id,
    subjectPoolId: r.subject_pool_id,
  };
}

export function insertLead(db: DB, input: InsertLeadInput): Lead {
  const result = db
    .prepare(
      `INSERT INTO leads
        (holder_actor_id, kind, side,
         subject_item_kind_id, subject_quality_tier,
         subject_target_actor_id, counterparty_actor_id,
         estimated_qty, estimated_unit_price, confidence,
         source_actor_id, acquired_day, hop_count, derived_from_lead_id,
         subject_pool_id)
       VALUES
        (@holder, @kind, @side,
         @item_kind, @tier,
         @target, @counterparty,
         @qty, @unit_price, @confidence,
         @source, @acquired_day, @hop_count, @derived_from,
         @pool)`,
    )
    .run({
      holder: input.holderActorId,
      kind: input.kind ?? "commodity",
      side: input.side,
      item_kind: input.subjectItemKindId ?? null,
      tier: input.subjectQualityTier ?? null,
      target: input.subjectTargetActorId ?? null,
      counterparty: input.counterpartyActorId ?? null,
      qty: input.estimatedQuantity,
      unit_price: input.estimatedUnitPrice,
      confidence: input.confidence ?? "warm",
      source: input.sourceActorId ?? null,
      acquired_day: input.acquiredDay,
      hop_count: input.hopCount ?? 0,
      derived_from: input.derivedFromLeadId ?? null,
      pool: input.subjectPoolId ?? null,
    });
  const fetched = getLeadById(db, result.lastInsertRowid);
  if (!fetched) throw new Error("failed to fetch newly inserted lead");
  return fetched;
}

export function getLeadById(db: DB, id: number): Lead | null {
  const row = db.prepare<LeadRow>(`SELECT * FROM leads WHERE id = @id`).get({ id });
  return row ? rowToLead(row) : null;
}

export function getLeadsByHolder(db: DB, holderActorId: number): Lead[] {
  return db
    .prepare<LeadRow>(
      `SELECT * FROM leads WHERE holder_actor_id = @id ORDER BY id ASC`,
    )
    .all({ id: holderActorId })
    .map(rowToLead);
}

/**
 * Supply leads held by `actor` for a given item kind, ordered by hop_count
 * ascending (closest to source first), then warm-before-cold. Used by the
 * settlement walk to satisfy short obligations. Only commodity leads — rep
 * leads share the table but mean something else.
 */
export function getSupplyLeadsForItem(
  db: DB,
  holderActorId: number,
  itemKindId: number,
): Lead[] {
  return db
    .prepare<LeadRow>(
      `SELECT * FROM leads
       WHERE holder_actor_id = @holder
         AND kind = 'commodity'
         AND side = 'supply'
         AND subject_item_kind_id = @kind
       ORDER BY hop_count ASC, confidence ASC, id ASC`,
    )
    .all({ holder: holderActorId, kind: itemKindId })
    .map(rowToLead);
}

/**
 * The freshest rep lead `holderActorId` currently holds about
 * `targetActorId`, or null if they hold none. "Freshest" means lowest
 * hop count, warm-first within that. The narrative this powers:
 * "Before I sit down with Boyce, what do I know about him?"
 */
export function getRepLeadAbout(
  db: DB,
  holderActorId: number,
  targetActorId: number,
): Lead | null {
  const row = db
    .prepare<LeadRow>(
      `SELECT * FROM leads
       WHERE holder_actor_id = @holder
         AND kind = 'rep'
         AND subject_target_actor_id = @target
       ORDER BY hop_count ASC, confidence ASC, id DESC
       LIMIT 1`,
    )
    .get({ holder: holderActorId, target: targetActorId });
  return row ? rowToLead(row) : null;
}

/** All rep leads `holderActorId` currently holds, freshest first. */
export function getRepLeadsBy(db: DB, holderActorId: number): Lead[] {
  return db
    .prepare<LeadRow>(
      `SELECT * FROM leads
       WHERE holder_actor_id = @holder
         AND kind = 'rep'
       ORDER BY hop_count ASC, confidence ASC, id DESC`,
    )
    .all({ holder: holderActorId })
    .map(rowToLead);
}

export function deleteLead(db: DB, leadId: number): void {
  db.prepare(`DELETE FROM leads WHERE id = @id`).run({ id: leadId });
}

/**
 * Mark leads older than `warmThresholdDays` as cold, and delete leads
 * older than `deleteThresholdDays`. Designed to run from the daily tick.
 */
export interface DecayLeadsResult {
  readonly cooled: number;
  readonly deleted: number;
}

export function decayLeads(
  db: DB,
  today: number,
  warmThresholdDays: number,
  deleteThresholdDays: number,
): DecayLeadsResult {
  if (deleteThresholdDays <= warmThresholdDays) {
    throw new Error("deleteThresholdDays must be greater than warmThresholdDays");
  }
  return db.transaction((): DecayLeadsResult => {
    // Null out the derived_from pointers of any lead whose parent is
    // about to be deleted — otherwise the FK blocks the delete.
    db.prepare(
      `UPDATE leads
       SET derived_from_lead_id = NULL
       WHERE derived_from_lead_id IN (
         SELECT id FROM leads
         WHERE (@today - acquired_day) >= @delete_threshold
       )`,
    ).run({ today, delete_threshold: deleteThresholdDays });

    const deleted = db
      .prepare(
        `DELETE FROM leads
         WHERE (@today - acquired_day) >= @delete_threshold`,
      )
      .run({ today, delete_threshold: deleteThresholdDays }).changes;

    const cooled = db
      .prepare(
        `UPDATE leads
         SET confidence = 'cold'
         WHERE confidence = 'warm'
           AND (@today - acquired_day) >= @warm_threshold`,
      )
      .run({ today, warm_threshold: warmThresholdDays }).changes;

    return { cooled, deleted };
  });
}

/**
 * Per-hop transform applied to the value-bearing fields of a lead as
 * it's retold. Returning the input unchanged is a faithful retelling;
 * the engine's gossip handlers wire in `mutateLead` to introduce drift.
 * Tests that don't care about mutation can leave this unset for an
 * exact-copy share.
 */
export interface ShareLeadMutator {
  (input: {
    readonly kind: Lead["kind"];
    readonly side: Lead["side"];
    readonly subjectQualityTier: Lead["subjectQualityTier"];
    readonly subjectTargetActorId: number | null;
    readonly counterpartyActorId: number | null;
    readonly estimatedQuantity: number;
    readonly estimatedUnitPrice: number;
    readonly subjectPoolId: number | null;
  }): {
    readonly kind: Lead["kind"];
    readonly side: Lead["side"];
    readonly subjectQualityTier: Lead["subjectQualityTier"];
    readonly subjectTargetActorId: number | null;
    readonly counterpartyActorId: number | null;
    readonly estimatedQuantity: number;
    readonly estimatedUnitPrice: number;
    readonly subjectPoolId: number | null;
  };
}

export interface ShareLeadOptions {
  /** Optional per-hop mutator. When omitted, the lead is copied
   *  verbatim into the receiver's bag (modulo hop+1 / cold). */
  readonly mutate?: ShareLeadMutator;
}

/**
 * Pass a lead from one actor to another — produces a new lead in the
 * recipient's bag with hop_count incremented and confidence stepped down
 * (warm leads become cold once retold). The original is left intact.
 *
 * If `opts.mutate` is supplied, the value-bearing fields (side, tier,
 * qty, price, pool grounding) run through the mutator before insert.
 * That's how information drift, tier slip, and role reversal happen —
 * one call site, one function, every gossip path covered.
 */
export function shareLead(
  db: DB,
  fromActorId: number,
  toActorId: number,
  leadId: number,
  onDay: number,
  opts?: ShareLeadOptions,
): Lead {
  return db.transaction((): Lead => {
    const source = getLeadById(db, leadId);
    if (!source) throw new Error(`lead ${leadId} not found`);
    if (source.holderActorId !== fromActorId) {
      throw new Error(`actor ${fromActorId} doesn't hold lead ${leadId}`);
    }
    if (fromActorId === toActorId) {
      throw new Error(`cannot share a lead with oneself`);
    }
    const sourceFields = {
      kind: source.kind,
      side: source.side,
      subjectQualityTier: source.subjectQualityTier,
      subjectTargetActorId: source.subjectTargetActorId,
      counterpartyActorId: source.counterpartyActorId,
      estimatedQuantity: source.estimatedQuantity,
      estimatedUnitPrice: source.estimatedUnitPrice,
      // The pool reference propagates by default — two retold leads
      // pointing at the same pool reveal the over-count.
      subjectPoolId: source.subjectPoolId,
    };
    const transferred = opts?.mutate ? opts.mutate(sourceFields) : sourceFields;
    return insertLead(db, {
      holderActorId: toActorId,
      kind: transferred.kind,
      side: transferred.side,
      subjectItemKindId: source.subjectItemKindId,
      subjectQualityTier: transferred.subjectQualityTier,
      subjectTargetActorId: transferred.subjectTargetActorId,
      counterpartyActorId: transferred.counterpartyActorId,
      estimatedQuantity: transferred.estimatedQuantity,
      estimatedUnitPrice: transferred.estimatedUnitPrice,
      // Retold leads are hearsay — always cold from here on.
      confidence: "cold",
      sourceActorId: fromActorId,
      acquiredDay: onDay,
      hopCount: source.hopCount + 1,
      derivedFromLeadId: source.id,
      subjectPoolId: transferred.subjectPoolId,
    });
  });
}

/**
 * Tuple uniquely identifying a "subject" — the conjunction of fields the
 * gossip-novelty filter compares on, minus the numeric values that drift
 * per hop. Used by `clarifyLead` to find the target's matching lead on
 * a subject the asker is curious about.
 */
export interface LeadSubjectKey {
  readonly side: Lead["side"];
  readonly subjectItemKindId: number;
  readonly subjectQualityTier: Lead["subjectQualityTier"];
  readonly counterpartyActorId: number | null;
}

/**
 * Targeted information request — the cousin of `shareLead`. Where
 * `shareLead` says "tell them something they don't know," `clarifyLead`
 * says "tell them what *you* know about this specific subject."
 *
 * The asker brings a subject (their version of a lead); the target
 * looks up their own lead matching that subject and shares the freshest
 * one (lowest hop, warm-first). Mutation applies as usual. The asker's
 * existing lead on the subject is *not* removed — both versions persist
 * so divergent numbers / tiers / sides are visible side-by-side in the
 * asker's ledger.
 *
 * Returns the newly inserted lead in the asker's bag, or `null` if the
 * target had nothing on the subject. No event is emitted at this layer
 * — the calling handler decides whether to fire a `gossip.exchanged`.
 */
export function clarifyLead(
  db: DB,
  askerActorId: number,
  targetActorId: number,
  subject: LeadSubjectKey,
  onDay: number,
  opts?: ShareLeadOptions,
): Lead | null {
  if (askerActorId === targetActorId) return null;
  const rows = db
    .prepare<LeadRow>(
      `SELECT * FROM leads
       WHERE holder_actor_id = @holder
         AND kind = 'commodity'
         AND side = @side
         AND subject_item_kind_id = @kind
         AND ((subject_quality_tier IS NULL AND @tier IS NULL)
              OR subject_quality_tier = @tier)
         AND ((counterparty_actor_id IS NULL AND @counterparty IS NULL)
              OR counterparty_actor_id = @counterparty)
       ORDER BY hop_count ASC, confidence ASC, id DESC`,
    )
    .all({
      holder: targetActorId,
      side: subject.side,
      kind: subject.subjectItemKindId,
      tier: subject.subjectQualityTier ?? null,
      counterparty: subject.counterpartyActorId ?? null,
    });
  if (rows.length === 0) return null;
  const best = rowToLead(rows[0]!);
  return shareLead(db, targetActorId, askerActorId, best.id, onDay, opts);
}
