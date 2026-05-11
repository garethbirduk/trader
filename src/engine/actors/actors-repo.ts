import type { DB } from "../core/db.js";
import type { Actor, TransportCapacity } from "./types.js";
import { isTransportCapacity } from "./types.js";

export interface InsertActorInput {
  readonly code: string;
  readonly displayName: string;
  readonly cash?: number;
  readonly transportCapacity?: TransportCapacity;
  readonly homeLocationId?: number | null;
  readonly lockupLocationId?: number | null;
  /** Mark this actor as a virtual external producer/consumer. They
   *  don't tick, don't pubdeal, don't have a routine — they exist
   *  as records so they can own pools and be named by gossip. */
  readonly isVirtual?: boolean;
}

interface ActorRow {
  id: number;
  code: string;
  display_name: string;
  cash: number;
  current_location_id: number | null;
  home_location_id: number | null;
  lockup_location_id: number | null;
  transport_capacity: string;
  is_virtual: number;
}

function rowToActor(r: ActorRow): Actor {
  if (!isTransportCapacity(r.transport_capacity)) {
    throw new Error(`invalid transport_capacity in DB: ${r.transport_capacity}`);
  }
  return {
    id: r.id,
    code: r.code,
    displayName: r.display_name,
    cash: r.cash,
    currentLocationId: r.current_location_id,
    homeLocationId: r.home_location_id,
    lockupLocationId: r.lockup_location_id,
    transportCapacity: r.transport_capacity,
    isVirtual: r.is_virtual === 1,
  };
}

export function insertActor(db: DB, input: InsertActorInput): Actor {
  const cash = input.cash ?? 0;
  const transportCapacity = input.transportCapacity ?? "pocket";
  const homeLocationId = input.homeLocationId ?? null;
  const lockupLocationId = input.lockupLocationId ?? null;
  const isVirtual = input.isVirtual === true;
  const result = db
    .prepare(
      `INSERT INTO actors (code, display_name, cash, transport_capacity,
                           home_location_id, lockup_location_id, is_virtual)
       VALUES (@code, @display_name, @cash, @transport_capacity,
               @home_location_id, @lockup_location_id, @is_virtual)`,
    )
    .run({
      code: input.code,
      display_name: input.displayName,
      cash,
      transport_capacity: transportCapacity,
      home_location_id: homeLocationId,
      lockup_location_id: lockupLocationId,
      is_virtual: isVirtual ? 1 : 0,
    });
  return {
    id: result.lastInsertRowid,
    code: input.code,
    displayName: input.displayName,
    cash,
    currentLocationId: null,
    homeLocationId,
    lockupLocationId,
    transportCapacity,
    isVirtual,
  };
}

/** All non-virtual actors — the "live" cast that ticks. Virtual
 *  producers/consumers are excluded. */
export function listLiveActors(db: DB): Actor[] {
  return db
    .prepare<ActorRow>(
      `SELECT * FROM actors WHERE is_virtual = 0 ORDER BY id ASC`,
    )
    .all()
    .map(rowToActor);
}

/** All virtual actors only. Used by the viewer to surface the
 *  external-producer cast separately. */
export function listVirtualActors(db: DB): Actor[] {
  return db
    .prepare<ActorRow>(
      `SELECT * FROM actors WHERE is_virtual = 1 ORDER BY id ASC`,
    )
    .all()
    .map(rowToActor);
}

export function setActorHome(
  db: DB,
  actorId: number,
  homeLocationId: number | null,
): void {
  db.prepare(
    `UPDATE actors SET home_location_id = @home WHERE id = @id`,
  ).run({ id: actorId, home: homeLocationId });
}

export function setActorLockup(
  db: DB,
  actorId: number,
  lockupLocationId: number | null,
): void {
  db.prepare(
    `UPDATE actors SET lockup_location_id = @lockup WHERE id = @id`,
  ).run({ id: actorId, lockup: lockupLocationId });
}

export function getActorById(db: DB, id: number): Actor | null {
  const row = db
    .prepare<ActorRow>(`SELECT * FROM actors WHERE id = @id`)
    .get({ id });
  return row ? rowToActor(row) : null;
}

export function getActorByCode(db: DB, code: string): Actor | null {
  const row = db
    .prepare<ActorRow>(`SELECT * FROM actors WHERE code = @code`)
    .get({ code });
  return row ? rowToActor(row) : null;
}

export function listActors(db: DB): Actor[] {
  return db
    .prepare<ActorRow>(`SELECT * FROM actors ORDER BY id ASC`)
    .all()
    .map(rowToActor);
}

export function adjustActorCash(db: DB, actorId: number, delta: number): Actor {
  const updated = db
    .prepare<ActorRow>(
      `UPDATE actors SET cash = cash + @delta
       WHERE id = @id
       RETURNING *`,
    )
    .get({ id: actorId, delta });
  if (!updated) throw new Error(`actor ${actorId} not found`);
  return rowToActor(updated);
}
