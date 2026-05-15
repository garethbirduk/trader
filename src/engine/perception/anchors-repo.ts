import type { DB } from "../core/db.js";

/**
 * Per-category "uninformed prior" — the £ value a member of the public
 * with zero expertise on the category would guess an average item is
 * worth. The floor of the `lerp(anchor, truth, expertise)` centre
 * computation in `estimate()`.
 *
 * One row per category; seeded by the skin. Missing rows fall back
 * to the engine's `DEFAULT_ANCHOR_FALLBACK` so call sites never crash.
 */

interface AnchorRow {
  category: string;
  anchor_value: number;
}

/**
 * Fallback when a category has no anchor row. Set generously so a
 * mis-seeded skin still produces non-zero centres; production skins
 * should always seed every category in their catalogue.
 */
export const DEFAULT_ANCHOR_FALLBACK = 30;

export function setCategoryAnchor(
  db: DB,
  category: string,
  anchorValue: number,
): void {
  if (anchorValue < 0 || !Number.isFinite(anchorValue)) {
    throw new Error(
      `anchor_value must be a finite non-negative number; got ${anchorValue} ` +
        `for category '${category}'`,
    );
  }
  db.prepare(
    `INSERT INTO category_anchors (category, anchor_value)
     VALUES (@cat, @val)
     ON CONFLICT (category) DO UPDATE SET anchor_value = excluded.anchor_value`,
  ).run({ cat: category, val: Math.round(anchorValue) });
}

export function getCategoryAnchor(db: DB, category: string): number {
  const row = db
    .prepare<AnchorRow>(
      `SELECT * FROM category_anchors WHERE category = @cat`,
    )
    .get({ cat: category });
  return row?.anchor_value ?? DEFAULT_ANCHOR_FALLBACK;
}

export function getAllCategoryAnchors(db: DB): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const row of db
    .prepare<AnchorRow>(`SELECT * FROM category_anchors`)
    .all()) {
    out.set(row.category, row.anchor_value);
  }
  return out;
}

export function seedCategoryAnchors(
  db: DB,
  anchorsByCategory: ReadonlyMap<string, number>,
): void {
  db.transaction(() => {
    for (const [cat, val] of anchorsByCategory) {
      setCategoryAnchor(db, cat, val);
    }
  });
}
