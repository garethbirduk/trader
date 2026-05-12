import type { DB } from "../core/db.js";
import { getItemKindByCode, getItemKindById } from "../stock/items-repo.js";
import { pairCode } from "./types.js";

/**
 * Confusable pair persistence. Each row represents a single
 * "confusion axis" between two item kinds — knowing which side of the
 * pair you're holding is the actor's id-skill on that pair.
 */

export interface ConfusablePair {
  readonly id: number;
  readonly kindAId: number;
  readonly kindBId: number;
  readonly kindACode: string;
  readonly kindBCode: string;
  readonly difficulty: number;
  /** The canonical pair code, derived from the two codes lexicographically. */
  readonly pairCode: string;
}

interface PairRow {
  id: number;
  kind_a_id: number;
  kind_b_id: number;
  kind_a_code: string;
  kind_b_code: string;
  difficulty: number;
}

function rowToPair(r: PairRow): ConfusablePair {
  // Canonical pair code: by construction kind_a_code < kind_b_code in
  // the DB ordering when both kinds were named lex-sortably, but the
  // pair-canonicalisation is keyed on the codes themselves rather than
  // the ids, so we recompute from the codes here to stay safe.
  return {
    id: r.id,
    kindAId: r.kind_a_id,
    kindBId: r.kind_b_id,
    kindACode: r.kind_a_code,
    kindBCode: r.kind_b_code,
    difficulty: r.difficulty,
    pairCode: pairCode(r.kind_a_code, r.kind_b_code),
  };
}

const SELECT_WITH_CODES = `
  SELECT cp.*, ka.code AS kind_a_code, kb.code AS kind_b_code
    FROM confusable_item_pairs cp
    JOIN item_kinds ka ON ka.id = cp.kind_a_id
    JOIN item_kinds kb ON kb.id = cp.kind_b_id
`;

/**
 * Register a confusable pair. Canonicalises kind ordering so
 * (Rolex, Rulex) and (Rulex, Rolex) collapse to the same row.
 */
export function addConfusablePair(
  db: DB,
  args: {
    kindAId: number;
    kindBId: number;
    difficulty: number;
  },
): ConfusablePair {
  if (args.kindAId === args.kindBId) {
    throw new Error(`confusable pair requires two distinct kinds`);
  }
  if (args.difficulty < 0 || args.difficulty > 1) {
    throw new Error(`difficulty must be in [0, 1]; got ${args.difficulty}`);
  }
  // Canonicalise on id to satisfy the CHECK constraint.
  const [lo, hi] =
    args.kindAId < args.kindBId
      ? [args.kindAId, args.kindBId]
      : [args.kindBId, args.kindAId];
  db.prepare(
    `INSERT OR REPLACE INTO confusable_item_pairs
       (kind_a_id, kind_b_id, difficulty)
     VALUES (@a, @b, @d)`,
  ).run({ a: lo, b: hi, d: args.difficulty });
  const row = db
    .prepare<PairRow>(
      `${SELECT_WITH_CODES} WHERE cp.kind_a_id = @a AND cp.kind_b_id = @b`,
    )
    .get({ a: lo, b: hi });
  if (!row) throw new Error(`failed to fetch newly inserted confusable pair`);
  return rowToPair(row);
}

/**
 * Convenience overload that takes codes — looks the ids up, then
 * delegates. Useful for skin setup where everything is named.
 */
export function addConfusablePairByCodes(
  db: DB,
  args: {
    kindACode: string;
    kindBCode: string;
    difficulty: number;
  },
): ConfusablePair {
  const a = getItemKindByCode(db, args.kindACode);
  if (!a) throw new Error(`item kind not found: ${args.kindACode}`);
  const b = getItemKindByCode(db, args.kindBCode);
  if (!b) throw new Error(`item kind not found: ${args.kindBCode}`);
  return addConfusablePair(db, {
    kindAId: a.id,
    kindBId: b.id,
    difficulty: args.difficulty,
  });
}

/** All pairs involving the given kind (from either side). */
export function getConfusablePairsForKind(
  db: DB,
  kindId: number,
): ConfusablePair[] {
  return db
    .prepare<PairRow>(
      `${SELECT_WITH_CODES}
        WHERE cp.kind_a_id = @id OR cp.kind_b_id = @id`,
    )
    .all({ id: kindId })
    .map(rowToPair);
}

/**
 * Given a kind, return all the other kinds it can be confused with
 * (along with the pair's difficulty and the pair code that scopes the
 * id-skill for the actor).
 */
export interface ConfusableNeighbour {
  readonly kindId: number;
  readonly kindCode: string;
  readonly difficulty: number;
  readonly pairCode: string;
}

export function getConfusableNeighbours(
  db: DB,
  kindId: number,
): ConfusableNeighbour[] {
  const pairs = getConfusablePairsForKind(db, kindId);
  const out: ConfusableNeighbour[] = [];
  for (const p of pairs) {
    if (p.kindAId === kindId) {
      out.push({
        kindId: p.kindBId,
        kindCode: p.kindBCode,
        difficulty: p.difficulty,
        pairCode: p.pairCode,
      });
    } else {
      out.push({
        kindId: p.kindAId,
        kindCode: p.kindACode,
        difficulty: p.difficulty,
        pairCode: p.pairCode,
      });
    }
  }
  return out;
}

/**
 * Lookup helper: are these two kinds confusable, and if so with what
 * difficulty? Returns null when the pair is not registered.
 */
export function getConfusablePair(
  db: DB,
  kindAId: number,
  kindBId: number,
): ConfusablePair | null {
  if (kindAId === kindBId) return null;
  const [lo, hi] =
    kindAId < kindBId ? [kindAId, kindBId] : [kindBId, kindAId];
  const row = db
    .prepare<PairRow>(
      `${SELECT_WITH_CODES}
        WHERE cp.kind_a_id = @a AND cp.kind_b_id = @b`,
    )
    .get({ a: lo, b: hi });
  return row ? rowToPair(row) : null;
}

/**
 * Throw-on-missing variant for code paths that have already verified
 * a kind exists upstream — gives a clearer error than the generic
 * "no row" surface from the raw query.
 */
export function requireKindByIdForPair(db: DB, id: number): { code: string } {
  const k = getItemKindById(db, id);
  if (!k) throw new Error(`item_kind ${id} not found (confusable pair lookup)`);
  return { code: k.code };
}
