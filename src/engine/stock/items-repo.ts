import type { DB } from "../core/db.js";
import type { FlawType, ItemKind, ItemSize } from "./types.js";
import { isFlawType, isItemSize } from "./types.js";

export interface InsertItemKindInput {
  readonly code: string;
  readonly displayName: string;
  readonly category: string;
  readonly baseValue: number;
  readonly flawType?: FlawType | null;
  readonly risk?: number;
  readonly targetCustomers?: readonly string[];
  readonly isEasterEgg?: boolean;
  readonly flavourText?: string | null;
  readonly spawnWeight?: number;
  /** Physical size — defaults to 'mid'. */
  readonly size?: ItemSize;
}

interface ItemKindRow {
  id: number;
  code: string;
  display_name: string;
  category: string;
  base_value: number;
  flaw_type: string | null;
  risk: number;
  target_customers: string;
  is_easter_egg: number;
  flavour_text: string | null;
  spawn_weight: number;
  size: string;
}

function rowToItemKind(r: ItemKindRow): ItemKind {
  if (r.flaw_type !== null && !isFlawType(r.flaw_type)) {
    throw new Error(`invalid flaw_type in DB: ${r.flaw_type}`);
  }
  if (!isItemSize(r.size)) {
    throw new Error(`invalid size in DB: ${r.size}`);
  }
  const targetCustomers =
    r.target_customers.length === 0
      ? []
      : r.target_customers.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return {
    id: r.id,
    code: r.code,
    displayName: r.display_name,
    category: r.category,
    baseValue: r.base_value,
    flawType: r.flaw_type as FlawType | null,
    risk: r.risk,
    targetCustomers,
    isEasterEgg: r.is_easter_egg === 1,
    flavourText: r.flavour_text,
    spawnWeight: r.spawn_weight,
    size: r.size,
  };
}

export function insertItemKind(db: DB, input: InsertItemKindInput): ItemKind {
  const targetCustomersStr = (input.targetCustomers ?? []).join(",");
  const result = db
    .prepare(
      `INSERT INTO item_kinds
        (code, display_name, category, base_value, flaw_type, risk,
         target_customers, is_easter_egg, flavour_text, spawn_weight, size)
       VALUES
        (@code, @display_name, @category, @base_value, @flaw_type, @risk,
         @target_customers, @is_easter_egg, @flavour_text, @spawn_weight, @size)`,
    )
    .run({
      code: input.code,
      display_name: input.displayName,
      category: input.category,
      base_value: input.baseValue,
      flaw_type: input.flawType ?? null,
      risk: input.risk ?? 0,
      target_customers: targetCustomersStr,
      is_easter_egg: input.isEasterEgg ? 1 : 0,
      flavour_text: input.flavourText ?? null,
      spawn_weight: input.spawnWeight ?? 10,
      size: input.size ?? "mid",
    });
  const fetched = getItemKindById(db, result.lastInsertRowid);
  if (!fetched) throw new Error("failed to fetch newly inserted item_kind");
  return fetched;
}

export function getItemKindByCode(db: DB, code: string): ItemKind | null {
  const row = db
    .prepare<ItemKindRow>(`SELECT * FROM item_kinds WHERE code = @code`)
    .get({ code });
  return row ? rowToItemKind(row) : null;
}

export function getItemKindById(db: DB, id: number): ItemKind | null {
  const row = db
    .prepare<ItemKindRow>(`SELECT * FROM item_kinds WHERE id = @id`)
    .get({ id });
  return row ? rowToItemKind(row) : null;
}

export function listItemKinds(db: DB): ItemKind[] {
  return db
    .prepare<ItemKindRow>(`SELECT * FROM item_kinds ORDER BY id ASC`)
    .all()
    .map(rowToItemKind);
}

/** Items eligible for the pool spawner — spawnWeight > 0. */
export function listSpawnableItemKinds(db: DB): ItemKind[] {
  return db
    .prepare<ItemKindRow>(
      `SELECT * FROM item_kinds WHERE spawn_weight > 0 ORDER BY id ASC`,
    )
    .all()
    .map(rowToItemKind);
}
