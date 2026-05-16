import type { DB } from "../core/db.js";

/**
 * Per-category "uninformed prior" for the condition arm — the v2
 * condition arm's quality-scalar [0, 1] anchor that a clueless actor's
 * centre lerps toward. Parallel to `anchors-repo.ts` (the price prior)
 * but values are quality fractions, not £.
 *
 *   0.0 → broken-end prior ("most of this category is junk")
 *   0.5 → fair-end prior (v1 global default)
 *   1.0 → mint-end prior ("most of this category is near-new")
 *
 * One row per category; seeded by the skin. Missing rows fall back to
 * the engine's `DEFAULT_CONDITION_ANCHOR_FALLBACK` (0.5) so call sites
 * never crash on a mis-seeded skin.
 */

interface ConditionAnchorRow {
  category: string;
  anchor_value: number;
}

/**
 * Fallback when a category has no condition-anchor row. Set to 0.5
 * — the midpoint quality, matching the "fair" tier — so a missing
 * row reproduces the v1 global behaviour exactly.
 */
export const DEFAULT_CONDITION_ANCHOR_FALLBACK = 0.5;

export function setCategoryConditionAnchor(
  db: DB,
  category: string,
  anchorValue: number,
): void {
  if (
    !Number.isFinite(anchorValue) ||
    anchorValue < 0 ||
    anchorValue > 1
  ) {
    throw new Error(
      `condition anchor must be a finite scalar in [0, 1]; got ${anchorValue} ` +
        `for category '${category}'`,
    );
  }
  db.prepare(
    `INSERT INTO category_condition_anchors (category, anchor_value)
     VALUES (@cat, @val)
     ON CONFLICT (category) DO UPDATE SET anchor_value = excluded.anchor_value`,
  ).run({ cat: category, val: anchorValue });
}

export function getCategoryConditionAnchor(db: DB, category: string): number {
  const row = db
    .prepare<ConditionAnchorRow>(
      `SELECT * FROM category_condition_anchors WHERE category = @cat`,
    )
    .get({ cat: category });
  return row?.anchor_value ?? DEFAULT_CONDITION_ANCHOR_FALLBACK;
}

export function getAllCategoryConditionAnchors(
  db: DB,
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const row of db
    .prepare<ConditionAnchorRow>(`SELECT * FROM category_condition_anchors`)
    .all()) {
    out.set(row.category, row.anchor_value);
  }
  return out;
}

export function seedCategoryConditionAnchors(
  db: DB,
  anchorsByCategory: ReadonlyMap<string, number>,
): void {
  db.transaction(() => {
    for (const [cat, val] of anchorsByCategory) {
      setCategoryConditionAnchor(db, cat, val);
    }
  });
}
