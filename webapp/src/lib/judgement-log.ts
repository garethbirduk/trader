import type {
  CompositePayload,
  PriceArmPayload,
  RunDump,
  RunJudgement,
} from "../types.js";

/**
 * Client-side index over `dump.judgements` (docs/judgement.md —
 * "Judgement audit trail"). Lets event-row / decision-row components
 * look up "the math behind this decision" by (actor, contextKind,
 * contextRef) in O(1) without scanning the whole array each render.
 *
 * Built once per dump load and cached. Use `getJudgement(idx, …)`
 * for a single decision and `listJudgements(idx, …)` for a
 * (lot, contextKind) join that fans out across actors (e.g. one
 * auction lot's full bidder roster).
 */
export interface JudgementIndex {
  /** Map keyed by `${actorId}|${contextKind}|${contextRefId}` to a
   *  list of judgements matching that combo. Most combos have a
   *  single row, but the same (lot, kind) can fire for multiple
   *  hours in degenerate cases — keep all of them. */
  readonly byKey: ReadonlyMap<string, readonly RunJudgement[]>;
  /** Map keyed by `${contextKind}|${contextRefId}` to all
   *  judgements that share the same context ref across actors —
   *  natural for "show every bidder's math on this lot". */
  readonly byContext: ReadonlyMap<string, readonly RunJudgement[]>;
  /** Map keyed by judgement id for direct lookup. */
  readonly byId: ReadonlyMap<number, RunJudgement>;
}

const EMPTY_INDEX: JudgementIndex = {
  byKey: new Map(),
  byContext: new Map(),
  byId: new Map(),
};

/** Build the index. Cheap — one pass over `dump.judgements`. Idempotent. */
export function indexJudgements(dump: RunDump): JudgementIndex {
  const rows = dump.judgements;
  if (rows === undefined || rows.length === 0) return EMPTY_INDEX;

  const byKey = new Map<string, RunJudgement[]>();
  const byContext = new Map<string, RunJudgement[]>();
  const byId = new Map<number, RunJudgement>();

  for (const j of rows) {
    byId.set(j.id, j);
    const ctxKey = `${j.contextKind}|${j.contextRefId ?? "null"}`;
    let ctxList = byContext.get(ctxKey);
    if (ctxList === undefined) {
      ctxList = [];
      byContext.set(ctxKey, ctxList);
    }
    ctxList.push(j);
    const fullKey = `${j.actorId}|${ctxKey}`;
    let keyList = byKey.get(fullKey);
    if (keyList === undefined) {
      keyList = [];
      byKey.set(fullKey, keyList);
    }
    keyList.push(j);
  }
  return { byKey, byContext, byId };
}

/** Most-recent judgement matching (actor, kind, ref). Returns null
 *  when no match — older dumps without the judgement field, decisions
 *  that bypassed the audit, etc. */
export function getJudgement(
  idx: JudgementIndex,
  actorId: number,
  contextKind: string,
  contextRefId: number | null,
): RunJudgement | null {
  const key = `${actorId}|${contextKind}|${contextRefId ?? "null"}`;
  const list = idx.byKey.get(key);
  if (list === undefined || list.length === 0) return null;
  // Most-recent wins — the array preserves insertion order so the
  // last row is the latest in id order.
  return list[list.length - 1]!;
}

/** Lookup by judgement id (e.g. AuctionBidderSnapshot.judgementId). */
export function getJudgementById(
  idx: JudgementIndex,
  id: number,
): RunJudgement | null {
  return idx.byId.get(id) ?? null;
}

/** All judgements for a (kind, ref) pair, ordered by id. Useful for
 *  "show every bidder's math on this lot" — one auction lot's
 *  context_ref_id matches every qualifying bidder's row. */
export function listJudgements(
  idx: JudgementIndex,
  contextKind: string,
  contextRefId: number | null,
): readonly RunJudgement[] {
  return idx.byContext.get(`${contextKind}|${contextRefId ?? "null"}`) ?? [];
}

/** Type predicate — discriminates the payload by `record.arm`. */
export function isComposite(j: RunJudgement): j is RunJudgement & {
  readonly arm: "composite";
  readonly payload: CompositePayload;
} {
  return j.arm === "composite";
}

/** Type predicate — price-arm row (estimate / estimatePriceBand). */
export function isPriceArm(j: RunJudgement): j is RunJudgement & {
  readonly arm: "price";
  readonly payload: PriceArmPayload;
} {
  return j.arm === "price";
}
