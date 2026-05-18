import type { DB } from "../core/db.js";
import type { Actor, TransportCapacity } from "./types.js";
import { isTransportCapacity } from "./types.js";

export interface InsertActorInput {
  readonly code: string;
  /** Given name. Required. */
  readonly firstName: string;
  /** Family name. Omit / null for institutions and one-name characters. */
  readonly lastName?: string | null;
  /** Chip-friendly nickname or short label. Required. */
  readonly shortName: string;
  readonly cash?: number;
  readonly transportCapacity?: TransportCapacity;
  readonly homeLocationId?: number | null;
  readonly lockupLocationId?: number | null;
  /** Mark this actor as a virtual external producer/consumer. They
   *  don't tick, don't pubdeal, don't have a routine — they exist
   *  as records so they can own pools and be named by gossip. */
  readonly isVirtual?: boolean;
  /** Whether this actor takes bribes. Default false. */
  readonly bribable?: boolean;
  /** Character-arm scalar in [0, 1]. Default 0.5 (neutral). See
   *  Actor.socialScore for the mechanic. */
  readonly socialScore?: number;
}

interface ActorRow {
  id: number;
  code: string;
  display_name: string;
  first_name: string;
  last_name: string | null;
  short_name: string;
  cash: number;
  current_location_id: number | null;
  home_location_id: number | null;
  lockup_location_id: number | null;
  transport_capacity: string;
  is_virtual: number;
  bribable: number;
  social_score: number;
}

function composeDisplayName(firstName: string, lastName: string | null): string {
  if (lastName !== null && lastName.length > 0) {
    return `${firstName} ${lastName}`;
  }
  return firstName;
}

function rowToActor(r: ActorRow): Actor {
  if (!isTransportCapacity(r.transport_capacity)) {
    throw new Error(`invalid transport_capacity in DB: ${r.transport_capacity}`);
  }
  // first_name/short_name default to '' in the schema; if a legacy row
  // doesn't have them, fall back to display_name so reads still work.
  const firstName = r.first_name.length > 0 ? r.first_name : r.display_name;
  const lastName = r.last_name ?? null;
  const shortName = r.short_name.length > 0 ? r.short_name : firstName;
  return {
    id: r.id,
    code: r.code,
    firstName,
    lastName,
    shortName,
    displayName: r.display_name,
    cash: r.cash,
    currentLocationId: r.current_location_id,
    homeLocationId: r.home_location_id,
    lockupLocationId: r.lockup_location_id,
    transportCapacity: r.transport_capacity,
    isVirtual: r.is_virtual === 1,
    bribable: (r.bribable ?? 0) === 1,
    socialScore: r.social_score ?? 0.5,
  };
}

export function insertActor(db: DB, input: InsertActorInput): Actor {
  const cash = input.cash ?? 0;
  const transportCapacity = input.transportCapacity ?? "pocket";
  const homeLocationId = input.homeLocationId ?? null;
  const lockupLocationId = input.lockupLocationId ?? null;
  const isVirtual = input.isVirtual === true;
  const bribable = input.bribable === true;
  const socialScore = clamp01(input.socialScore ?? 0.5);
  const firstName = input.firstName;
  const lastName = input.lastName ?? null;
  const shortName = input.shortName;
  const displayName = composeDisplayName(firstName, lastName);
  const result = db
    .prepare(
      `INSERT INTO actors (code, display_name, first_name, last_name, short_name,
                           cash, transport_capacity,
                           home_location_id, lockup_location_id, is_virtual,
                           bribable, social_score)
       VALUES (@code, @display_name, @first_name, @last_name, @short_name,
               @cash, @transport_capacity,
               @home_location_id, @lockup_location_id, @is_virtual,
               @bribable, @social_score)`,
    )
    .run({
      code: input.code,
      display_name: displayName,
      first_name: firstName,
      last_name: lastName,
      short_name: shortName,
      cash,
      transport_capacity: transportCapacity,
      home_location_id: homeLocationId,
      lockup_location_id: lockupLocationId,
      is_virtual: isVirtual ? 1 : 0,
      bribable: bribable ? 1 : 0,
      social_score: socialScore,
    });
  return {
    id: result.lastInsertRowid,
    code: input.code,
    firstName,
    lastName,
    shortName,
    displayName,
    cash,
    currentLocationId: null,
    homeLocationId,
    lockupLocationId,
    transportCapacity,
    isVirtual,
    bribable,
    socialScore,
  };
}

export function setActorSocialScore(
  db: DB,
  actorId: number,
  socialScore: number,
): void {
  const clamped = clamp01(socialScore);
  db.prepare(`UPDATE actors SET social_score = @s WHERE id = @id`).run({
    id: actorId,
    s: clamped,
  });
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
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
