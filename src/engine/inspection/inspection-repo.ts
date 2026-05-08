import type { DB } from "../core/db.js";
import { isFlawType, type FlawType } from "../stock/types.js";

export interface KnownFlaw {
  readonly holderActorId: number;
  readonly itemKindId: number;
  readonly flawType: FlawType;
  readonly learnedDay: number;
  readonly learnedFromActorId: number | null;
}

interface KnownFlawRow {
  holder_actor_id: number;
  item_kind_id: number;
  flaw_type: string;
  learned_day: number;
  learned_from_actor_id: number | null;
}

function rowToKnownFlaw(r: KnownFlawRow): KnownFlaw {
  if (!isFlawType(r.flaw_type)) {
    throw new Error(`invalid flaw_type in actor_known_flaws: ${r.flaw_type}`);
  }
  return {
    holderActorId: r.holder_actor_id,
    itemKindId: r.item_kind_id,
    flawType: r.flaw_type,
    learnedDay: r.learned_day,
    learnedFromActorId: r.learned_from_actor_id,
  };
}

export function recordKnownFlaw(
  db: DB,
  args: {
    holderActorId: number;
    itemKindId: number;
    flawType: FlawType;
    learnedDay: number;
    learnedFromActorId?: number | null;
  },
): KnownFlaw {
  db.prepare(
    `INSERT OR IGNORE INTO actor_known_flaws
       (holder_actor_id, item_kind_id, flaw_type, learned_day, learned_from_actor_id)
     VALUES (@holder, @item, @flaw, @day, @from)`,
  ).run({
    holder: args.holderActorId,
    item: args.itemKindId,
    flaw: args.flawType,
    day: args.learnedDay,
    from: args.learnedFromActorId ?? null,
  });
  const row = db
    .prepare<KnownFlawRow>(
      `SELECT * FROM actor_known_flaws
       WHERE holder_actor_id = @holder
         AND item_kind_id = @item
         AND flaw_type = @flaw`,
    )
    .get({ holder: args.holderActorId, item: args.itemKindId, flaw: args.flawType });
  if (!row) throw new Error("failed to insert/fetch known flaw");
  return rowToKnownFlaw(row);
}

export function actorKnowsFlaw(
  db: DB,
  holderActorId: number,
  itemKindId: number,
  flawType: FlawType,
): boolean {
  const row = db
    .prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM actor_known_flaws
       WHERE holder_actor_id = @holder
         AND item_kind_id = @item
         AND flaw_type = @flaw`,
    )
    .get({ holder: holderActorId, item: itemKindId, flaw: flawType });
  return (row?.n ?? 0) > 0;
}

export function getKnownFlawsByActor(
  db: DB,
  holderActorId: number,
): KnownFlaw[] {
  return db
    .prepare<KnownFlawRow>(
      `SELECT * FROM actor_known_flaws
       WHERE holder_actor_id = @holder
       ORDER BY learned_day ASC, item_kind_id ASC`,
    )
    .all({ holder: holderActorId })
    .map(rowToKnownFlaw);
}
