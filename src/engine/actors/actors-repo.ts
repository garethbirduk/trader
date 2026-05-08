import type { DB } from "../core/db.js";
import type { Actor, TransportCapacity } from "./types.js";
import { isTransportCapacity } from "./types.js";

export interface InsertActorInput {
  readonly code: string;
  readonly displayName: string;
  readonly cash?: number;
  readonly transportCapacity?: TransportCapacity;
  readonly homeLocationId?: number | null;
}

interface ActorRow {
  id: number;
  code: string;
  display_name: string;
  cash: number;
  current_location_id: number | null;
  home_location_id: number | null;
  transport_capacity: string;
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
    transportCapacity: r.transport_capacity,
  };
}

export function insertActor(db: DB, input: InsertActorInput): Actor {
  const cash = input.cash ?? 0;
  const transportCapacity = input.transportCapacity ?? "pocket";
  const homeLocationId = input.homeLocationId ?? null;
  const result = db
    .prepare(
      `INSERT INTO actors (code, display_name, cash, transport_capacity, home_location_id)
       VALUES (@code, @display_name, @cash, @transport_capacity, @home_location_id)`,
    )
    .run({
      code: input.code,
      display_name: input.displayName,
      cash,
      transport_capacity: transportCapacity,
      home_location_id: homeLocationId,
    });
  return {
    id: result.lastInsertRowid,
    code: input.code,
    displayName: input.displayName,
    cash,
    currentLocationId: null,
    homeLocationId,
    transportCapacity,
  };
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
