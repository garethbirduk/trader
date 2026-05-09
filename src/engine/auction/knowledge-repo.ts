import type { DB } from "../core/db.js";

/**
 * Per-actor record of which auction lots they've heard about and which
 * they've inspected. Knowledge gates the listing details (item kind,
 * quantity, floor); inspection adds quality tier on top.
 *
 * Channels for knowledge acquisition:
 *  - 'paper'    — actor was at Sid's Café during open hours (06:00+)
 *  - 'gallery'  — actor was at Sotheby's from 08:00 onward
 *  - 'gossip'   — picked up via a gossip exchange at any location
 *  - 'attended' — actor was at Sotheby's during the auction hour itself
 */
export type LearnedVia = "paper" | "gallery" | "gossip" | "attended";

export interface KnownLotRow {
  readonly actorId: number;
  readonly lotId: number;
  readonly learnedDay: number;
  readonly learnedHour: number;
  readonly learnedVia: LearnedVia;
  readonly learnedFromActorId: number | null;
}

interface KnownLotRowRaw {
  actor_id: number;
  lot_id: number;
  learned_day: number;
  learned_hour: number;
  learned_via: string;
  learned_from_actor_id: number | null;
}

function isLearnedVia(s: string): s is LearnedVia {
  return s === "paper" || s === "gallery" || s === "gossip" || s === "attended";
}

function rowToKnown(r: KnownLotRowRaw): KnownLotRow {
  if (!isLearnedVia(r.learned_via)) {
    throw new Error(`invalid learned_via in actor_known_lots: ${r.learned_via}`);
  }
  return {
    actorId: r.actor_id,
    lotId: r.lot_id,
    learnedDay: r.learned_day,
    learnedHour: r.learned_hour,
    learnedVia: r.learned_via,
    learnedFromActorId: r.learned_from_actor_id,
  };
}

export function recordKnownLot(
  db: DB,
  args: {
    actorId: number;
    lotId: number;
    learnedDay: number;
    learnedHour: number;
    learnedVia: LearnedVia;
    learnedFromActorId?: number | null;
  },
): boolean {
  // INSERT OR IGNORE — first knowledge wins. Subsequent learnings of
  // the same lot are no-ops; we don't track the "second time you heard
  // about it" because the listing details don't change.
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO actor_known_lots
        (actor_id, lot_id, learned_day, learned_hour, learned_via, learned_from_actor_id)
       VALUES (@actor, @lot, @day, @hour, @via, @from)`,
    )
    .run({
      actor: args.actorId,
      lot: args.lotId,
      day: args.learnedDay,
      hour: args.learnedHour,
      via: args.learnedVia,
      from: args.learnedFromActorId ?? null,
    });
  return result.changes > 0;
}

export function actorKnowsLot(db: DB, actorId: number, lotId: number): boolean {
  const row = db
    .prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM actor_known_lots
        WHERE actor_id = @actor AND lot_id = @lot`,
    )
    .get({ actor: actorId, lot: lotId });
  return (row?.n ?? 0) > 0;
}

export function getKnownLotIdsByActor(db: DB, actorId: number): number[] {
  return db
    .prepare<{ lot_id: number }>(
      `SELECT lot_id FROM actor_known_lots WHERE actor_id = @actor`,
    )
    .all({ actor: actorId })
    .map((r) => r.lot_id);
}

export function listKnownLotRowsByActor(db: DB, actorId: number): KnownLotRow[] {
  return db
    .prepare<KnownLotRowRaw>(
      `SELECT * FROM actor_known_lots WHERE actor_id = @actor
        ORDER BY learned_day ASC, learned_hour ASC, lot_id ASC`,
    )
    .all({ actor: actorId })
    .map(rowToKnown);
}

export function listKnowersOfLot(db: DB, lotId: number): number[] {
  return db
    .prepare<{ actor_id: number }>(
      `SELECT actor_id FROM actor_known_lots WHERE lot_id = @lot`,
    )
    .all({ lot: lotId })
    .map((r) => r.actor_id);
}

export interface InspectedLotRow {
  readonly actorId: number;
  readonly lotId: number;
  readonly inspectedDay: number;
  readonly inspectedHour: number;
}

interface InspectedLotRowRaw {
  actor_id: number;
  lot_id: number;
  inspected_day: number;
  inspected_hour: number;
}

function rowToInspected(r: InspectedLotRowRaw): InspectedLotRow {
  return {
    actorId: r.actor_id,
    lotId: r.lot_id,
    inspectedDay: r.inspected_day,
    inspectedHour: r.inspected_hour,
  };
}

export function recordLotInspected(
  db: DB,
  args: {
    actorId: number;
    lotId: number;
    inspectedDay: number;
    inspectedHour: number;
  },
): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO actor_inspected_lots
        (actor_id, lot_id, inspected_day, inspected_hour)
       VALUES (@actor, @lot, @day, @hour)`,
    )
    .run({
      actor: args.actorId,
      lot: args.lotId,
      day: args.inspectedDay,
      hour: args.inspectedHour,
    });
  return result.changes > 0;
}

export function actorHasInspectedLot(
  db: DB,
  actorId: number,
  lotId: number,
): boolean {
  const row = db
    .prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM actor_inspected_lots
        WHERE actor_id = @actor AND lot_id = @lot`,
    )
    .get({ actor: actorId, lot: lotId });
  return (row?.n ?? 0) > 0;
}

export function listInspectedLotsByActor(
  db: DB,
  actorId: number,
): InspectedLotRow[] {
  return db
    .prepare<InspectedLotRowRaw>(
      `SELECT * FROM actor_inspected_lots WHERE actor_id = @actor
        ORDER BY inspected_day ASC, inspected_hour ASC, lot_id ASC`,
    )
    .all({ actor: actorId })
    .map(rowToInspected);
}
