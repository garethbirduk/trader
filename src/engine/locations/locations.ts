import type { DB } from "../core/db.js";

export type LocationType =
  | "home"
  | "business"
  | "pub"
  | "auction"
  | "civic"
  | "street"
  | "abstract";

const VALID_TYPES: ReadonlySet<string> = new Set([
  "home",
  "business",
  "pub",
  "auction",
  "civic",
  "street",
  "abstract",
]);

export interface OpenHours {
  readonly start: number;
  readonly end: number;
}

export interface Location {
  readonly id: number;
  readonly code: string;
  readonly displayName: string;
  readonly type: LocationType;
  readonly openHours: OpenHours | null;
}

export interface InsertLocationInput {
  readonly code: string;
  readonly displayName: string;
  readonly type?: LocationType;
  readonly openHours?: OpenHours | null;
}

interface LocationRow {
  id: number;
  code: string;
  display_name: string;
  type: string;
  open_hour_start: number | null;
  open_hour_end: number | null;
}

function rowToLocation(r: LocationRow): Location {
  if (!VALID_TYPES.has(r.type)) {
    throw new Error(`invalid location type in DB: ${r.type}`);
  }
  const openHours: OpenHours | null =
    r.open_hour_start !== null && r.open_hour_end !== null
      ? { start: r.open_hour_start, end: r.open_hour_end }
      : null;
  return {
    id: r.id,
    code: r.code,
    displayName: r.display_name,
    type: r.type as LocationType,
    openHours,
  };
}

export function insertLocation(db: DB, input: InsertLocationInput): Location {
  const type = input.type ?? "business";
  const openStart = input.openHours?.start ?? null;
  const openEnd = input.openHours?.end ?? null;
  const result = db
    .prepare(
      `INSERT INTO locations (code, display_name, type, open_hour_start, open_hour_end)
       VALUES (@code, @display_name, @type, @open_start, @open_end)`,
    )
    .run({
      code: input.code,
      display_name: input.displayName,
      type,
      open_start: openStart,
      open_end: openEnd,
    });
  return {
    id: result.lastInsertRowid,
    code: input.code,
    displayName: input.displayName,
    type,
    openHours: input.openHours ?? null,
  };
}

export function getLocationById(db: DB, id: number): Location | null {
  const row = db
    .prepare<LocationRow>(`SELECT * FROM locations WHERE id = @id`)
    .get({ id });
  return row ? rowToLocation(row) : null;
}

export function getLocationByCode(db: DB, code: string): Location | null {
  const row = db
    .prepare<LocationRow>(`SELECT * FROM locations WHERE code = @code`)
    .get({ code });
  return row ? rowToLocation(row) : null;
}

export function listLocations(db: DB): Location[] {
  return db
    .prepare<LocationRow>(`SELECT * FROM locations ORDER BY id ASC`)
    .all()
    .map(rowToLocation);
}

export function setActorLocation(
  db: DB,
  actorId: number,
  locationId: number | null,
): void {
  const result = db
    .prepare(
      `UPDATE actors SET current_location_id = @loc WHERE id = @id`,
    )
    .run({ id: actorId, loc: locationId });
  if (result.changes === 0) {
    throw new Error(`actor ${actorId} not found`);
  }
}

export function getActorCurrentLocationId(
  db: DB,
  actorId: number,
): number | null {
  const row = db
    .prepare<{ current_location_id: number | null }>(
      `SELECT current_location_id FROM actors WHERE id = @id`,
    )
    .get({ id: actorId });
  if (!row) throw new Error(`actor ${actorId} not found`);
  return row.current_location_id;
}

export function getActorsAtLocation(
  db: DB,
  locationId: number,
): readonly number[] {
  return db
    .prepare<{ id: number }>(
      `SELECT id FROM actors WHERE current_location_id = @loc ORDER BY id ASC`,
    )
    .all({ loc: locationId })
    .map((r) => r.id);
}

export function setLocationProprietor(
  db: DB,
  locationId: number,
  actorId: number | null,
): void {
  const r = db
    .prepare(
      `UPDATE locations SET proprietor_actor_id = @actor WHERE id = @id`,
    )
    .run({ id: locationId, actor: actorId });
  if (r.changes === 0) {
    throw new Error(`location ${locationId} not found`);
  }
}

export function getLocationProprietor(
  db: DB,
  locationId: number,
): number | null {
  const row = db
    .prepare<{ proprietor_actor_id: number | null }>(
      `SELECT proprietor_actor_id FROM locations WHERE id = @id`,
    )
    .get({ id: locationId });
  return row?.proprietor_actor_id ?? null;
}
