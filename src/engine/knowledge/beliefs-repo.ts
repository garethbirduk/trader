import type { DB } from "../core/db.js";
import { isFlawType, isQualityTier } from "../stock/types.js";
import type { FlawType, QualityTier } from "../stock/types.js";
import {
  isKnowledgeAxis,
  type ActorBelief,
  type BeliefValue,
  type KnowledgeAxis,
} from "./types.js";

/**
 * Persistent per-(actor, lot) belief log. Each consultation writes
 * one row. Conflicting reads on the same axis coexist — the viewer
 * (and the aggregator) decide what to do with the mixture.
 */

interface BeliefRow {
  id: number;
  actor_id: number;
  lot_id: number;
  axis: string;
  value_json: string;
  confidence: number;
  sourced_from_actor_id: number | null;
  acquired_day: number;
}

function encodeValue(value: BeliefValue): string {
  switch (value.axis) {
    case "id":
      return JSON.stringify({ kindId: value.kindId });
    case "condition":
      return JSON.stringify({ tier: value.tier });
    case "flaw":
      return JSON.stringify({ flawType: value.flawType });
    case "price": {
      const payload: Record<string, unknown> = {
        low: value.low,
        high: value.high,
      };
      if (value.forKindId !== undefined) payload.forKindId = value.forKindId;
      if (value.forTier !== undefined) payload.forTier = value.forTier;
      if (value.forFlaw !== undefined) payload.forFlaw = value.forFlaw;
      return JSON.stringify(payload);
    }
    case "customer_fit":
      return JSON.stringify({ types: value.types });
  }
}

function decodeValue(axis: KnowledgeAxis, json: string): BeliefValue {
  const obj = JSON.parse(json) as Record<string, unknown>;
  switch (axis) {
    case "id": {
      const kindId = obj.kindId;
      if (typeof kindId !== "number") {
        throw new Error(`belief id payload missing numeric kindId`);
      }
      return { axis: "id", kindId };
    }
    case "condition": {
      const tier = obj.tier;
      if (!isQualityTier(tier)) {
        throw new Error(`belief condition payload has invalid tier: ${tier}`);
      }
      return { axis: "condition", tier };
    }
    case "flaw": {
      const ft = obj.flawType;
      if (ft === null) return { axis: "flaw", flawType: null };
      if (!isFlawType(ft)) {
        throw new Error(`belief flaw payload has invalid flawType: ${ft}`);
      }
      return { axis: "flaw", flawType: ft as FlawType };
    }
    case "price": {
      const lo = obj.low;
      const hi = obj.high;
      if (typeof lo !== "number" || typeof hi !== "number") {
        throw new Error(`belief price payload missing numeric low/high`);
      }
      const out: BeliefValue & { axis: "price" } = {
        axis: "price",
        low: lo,
        high: hi,
      };
      if (typeof obj.forKindId === "number") {
        (out as { forKindId?: number }).forKindId = obj.forKindId;
      }
      if (typeof obj.forTier === "string" && isQualityTier(obj.forTier)) {
        (out as { forTier?: QualityTier }).forTier = obj.forTier;
      }
      if (obj.forFlaw === null) {
        (out as { forFlaw?: FlawType | null }).forFlaw = null;
      } else if (typeof obj.forFlaw === "string" && isFlawType(obj.forFlaw)) {
        (out as { forFlaw?: FlawType | null }).forFlaw = obj.forFlaw;
      }
      return out;
    }
    case "customer_fit": {
      const types = obj.types;
      if (
        !Array.isArray(types) ||
        types.some((t) => typeof t !== "string")
      ) {
        throw new Error(`belief customer_fit payload requires string[]`);
      }
      return { axis: "customer_fit", types: types as string[] };
    }
  }
}

function rowToBelief(r: BeliefRow): ActorBelief {
  if (!isKnowledgeAxis(r.axis)) {
    throw new Error(`invalid axis in actor_beliefs: ${r.axis}`);
  }
  return {
    id: r.id,
    actorId: r.actor_id,
    lotId: r.lot_id,
    axis: r.axis,
    value: decodeValue(r.axis, r.value_json),
    confidence: r.confidence,
    sourcedFromActorId: r.sourced_from_actor_id,
    acquiredDay: r.acquired_day,
  };
}

export interface RecordBeliefArgs {
  readonly actorId: number;
  readonly lotId: number;
  readonly value: BeliefValue;
  readonly confidence: number;
  readonly sourcedFromActorId: number | null;
  readonly acquiredDay: number;
}

export function recordBelief(db: DB, args: RecordBeliefArgs): ActorBelief {
  if (args.confidence < 0 || args.confidence > 1) {
    throw new Error(
      `confidence must be in [0, 1]; got ${args.confidence} on ${args.value.axis} belief`,
    );
  }
  const result = db
    .prepare(
      `INSERT INTO actor_beliefs
         (actor_id, lot_id, axis, value_json, confidence,
          sourced_from_actor_id, acquired_day)
       VALUES (@actor, @lot, @axis, @json, @conf, @from, @day)`,
    )
    .run({
      actor: args.actorId,
      lot: args.lotId,
      axis: args.value.axis,
      json: encodeValue(args.value),
      conf: args.confidence,
      from: args.sourcedFromActorId,
      day: args.acquiredDay,
    });
  const row = db
    .prepare<BeliefRow>(`SELECT * FROM actor_beliefs WHERE id = @id`)
    .get({ id: result.lastInsertRowid });
  if (!row) throw new Error("failed to fetch newly inserted belief");
  return rowToBelief(row);
}

/** All beliefs an actor holds about one lot, ordered by axis then day. */
export function getBeliefsForLot(
  db: DB,
  actorId: number,
  lotId: number,
): ActorBelief[] {
  return db
    .prepare<BeliefRow>(
      `SELECT * FROM actor_beliefs
        WHERE actor_id = @actor AND lot_id = @lot
        ORDER BY axis ASC, acquired_day ASC, id ASC`,
    )
    .all({ actor: actorId, lot: lotId })
    .map(rowToBelief);
}

/** Beliefs on one axis only — used by the aggregator to integrate. */
export function getBeliefsForAxis(
  db: DB,
  actorId: number,
  lotId: number,
  axis: KnowledgeAxis,
): ActorBelief[] {
  return db
    .prepare<BeliefRow>(
      `SELECT * FROM actor_beliefs
        WHERE actor_id = @actor AND lot_id = @lot AND axis = @axis
        ORDER BY acquired_day ASC, id ASC`,
    )
    .all({ actor: actorId, lot: lotId, axis })
    .map(rowToBelief);
}

/** Discard a belief — used when an actor learns it was wrong. */
export function deleteBelief(db: DB, id: number): void {
  db.prepare(`DELETE FROM actor_beliefs WHERE id = @id`).run({ id });
}

export type { BeliefValue, KnowledgeAxis, ActorBelief };
