import type { DB } from "../core/db.js";

/**
 * Per-(actor, category) band partition repo.
 *
 * Each row is one band the actor perceives in this category's price
 * range. The set of rows for (actor_id, category) is their full
 * mental model of the axis. The actor doesn't necessarily cover the
 * whole global range — an idiot with one band (£2000, £10000) only
 * knows that chunk; items outside it have no band and fall back to
 * "I have no model for this."
 *
 * Bands aren't required to be contiguous or sorted by `band_idx` —
 * `band_idx` is just a stable ordering hint for the viewer (so the
 * actor's bands render in a fixed order). The aggregator looks up
 * bands by which one contains the lot's price.
 */

export interface CategoryBand {
  readonly id: number;
  readonly actorId: number;
  readonly category: string;
  readonly low: number;
  readonly high: number;
  readonly bandIdx: number;
}

interface BandRow {
  id: number;
  actor_id: number;
  category: string;
  low: number;
  high: number;
  band_idx: number;
}

function rowToBand(r: BandRow): CategoryBand {
  return {
    id: r.id,
    actorId: r.actor_id,
    category: r.category,
    low: r.low,
    high: r.high,
    bandIdx: r.band_idx,
  };
}

/**
 * Set an actor's full partition for one category. Replaces any
 * existing rows for the (actor, category) pair atomically. Bands
 * are auto-indexed in the order supplied.
 */
export function setActorBands(
  db: DB,
  args: {
    actorId: number;
    category: string;
    bands: readonly { low: number; high: number }[];
  },
): CategoryBand[] {
  for (const b of args.bands) {
    if (b.low < 0) throw new Error(`band.low must be >= 0; got ${b.low}`);
    if (b.high <= b.low) {
      throw new Error(`band.high (${b.high}) must exceed low (${b.low})`);
    }
  }
  return db.transaction(() => {
    db.prepare(
      `DELETE FROM actor_category_bands
        WHERE actor_id = @actor AND category = @cat`,
    ).run({ actor: args.actorId, cat: args.category });

    const insert = db.prepare(
      `INSERT INTO actor_category_bands
         (actor_id, category, low, high, band_idx)
       VALUES (@actor, @cat, @low, @high, @idx)`,
    );
    args.bands.forEach((b, idx) => {
      insert.run({
        actor: args.actorId,
        cat: args.category,
        low: b.low,
        high: b.high,
        idx,
      });
    });
    return getActorBands(db, args.actorId, args.category);
  });
}

export function getActorBands(
  db: DB,
  actorId: number,
  category: string,
): CategoryBand[] {
  return db
    .prepare<BandRow>(
      `SELECT * FROM actor_category_bands
        WHERE actor_id = @actor AND category = @cat
        ORDER BY band_idx ASC`,
    )
    .all({ actor: actorId, cat: category })
    .map(rowToBand);
}

/**
 * Look up which band of the actor's partition contains the given
 * price. Returns null when the price falls outside every declared
 * band — the actor has no mental model for items at that price.
 */
export function findBandContaining(
  db: DB,
  actorId: number,
  category: string,
  price: number,
): CategoryBand | null {
  const bands = getActorBands(db, actorId, category);
  for (const b of bands) {
    if (price >= b.low && price <= b.high) return b;
  }
  return null;
}

/**
 * For an actor that has bands set on this category, find the band
 * nearest to the price (in £ distance to the nearest endpoint).
 * Used by the aggregator's placement-miss fallback: a low-skill
 * actor mis-places a lot into an adjacent band instead of returning
 * "no idea."
 */
export function findNearestBand(
  db: DB,
  actorId: number,
  category: string,
  price: number,
): CategoryBand | null {
  const bands = getActorBands(db, actorId, category);
  let best: CategoryBand | null = null;
  let bestDist = Infinity;
  for (const b of bands) {
    if (price >= b.low && price <= b.high) {
      return b;
    }
    const dist = price < b.low ? b.low - price : price - b.high;
    if (dist < bestDist) {
      bestDist = dist;
      best = b;
    }
  }
  return best;
}
