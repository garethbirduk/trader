import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import {
  insertLocation,
  setActorLocation,
} from "../src/engine/locations/locations.js";
import { seedWitnessLeads } from "../src/engine/witness/seed-witness-leads.js";
import { getLeadsByHolder } from "../src/engine/leads/leads-repo.js";
import type { DB } from "../src/engine/core/db.js";

describe("seedWitnessLeads", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("plants a rep lead in every present non-principal's bag", () => {
    db = freshDB();
    const market = insertLocation(db, { code: "market", displayName: "Market" });
    const del = insertActor(db, { code: "del", firstName: "Del", shortName: "Del" });
    const slater = insertActor(db, { code: "slater", firstName: "Slater", shortName: "Slater" });
    const trigger = insertActor(db, { code: "trigger", firstName: "Trigger", shortName: "Trigger" });
    const denzil = insertActor(db, { code: "denzil", firstName: "Denzil", shortName: "Denzil" });
    setActorLocation(db, del.id, market.id);
    setActorLocation(db, slater.id, market.id);
    setActorLocation(db, trigger.id, market.id);
    setActorLocation(db, denzil.id, market.id);

    const result = seedWitnessLeads(db, {
      locationId: market.id,
      principalActorId: del.id,
      counterpartyActorId: slater.id,
      eventType: "bribe",
      context: { itemKindCode: "hi-fis", scenario: "look-the-other-way" },
      amount: 50,
      atDay: 3,
    });
    expect(result.witnessActorIds.sort()).toEqual([trigger.id, denzil.id].sort());
    expect(result.leadIds).toHaveLength(2);

    const triggerLeads = getLeadsByHolder(db, trigger.id);
    expect(triggerLeads).toHaveLength(1);
    const lead = triggerLeads[0]!;
    expect(lead.kind).toBe("rep");
    expect(lead.subjectTargetActorId).toBe(del.id);
    expect(lead.counterpartyActorId).toBe(slater.id);
    expect(lead.subjectEventType).toBe("bribe");
    expect(lead.estimatedUnitPrice).toBe(50);
    expect(lead.subjectContextJson).not.toBeNull();
    const ctx = JSON.parse(lead.subjectContextJson!);
    expect(ctx.itemKindCode).toBe("hi-fis");
  });

  it("excludes both principals from the witness set", () => {
    db = freshDB();
    const loc = insertLocation(db, { code: "x", displayName: "X" });
    const del = insertActor(db, { code: "del", firstName: "Del", shortName: "Del" });
    const slater = insertActor(db, { code: "slater", firstName: "Slater", shortName: "Slater" });
    setActorLocation(db, del.id, loc.id);
    setActorLocation(db, slater.id, loc.id);
    const result = seedWitnessLeads(db, {
      locationId: loc.id,
      principalActorId: del.id,
      counterpartyActorId: slater.id,
      eventType: "bribe",
      atDay: 1,
    });
    // No third party present → no leads.
    expect(result.witnessActorIds).toEqual([]);
    expect(result.leadIds).toEqual([]);
  });

  it("handles single-principal events (counterparty optional)", () => {
    db = freshDB();
    const loc = insertLocation(db, { code: "x", displayName: "X" });
    const del = insertActor(db, { code: "del", firstName: "Del", shortName: "Del" });
    const trigger = insertActor(db, { code: "trigger", firstName: "Trigger", shortName: "Trigger" });
    setActorLocation(db, del.id, loc.id);
    setActorLocation(db, trigger.id, loc.id);
    const result = seedWitnessLeads(db, {
      locationId: loc.id,
      principalActorId: del.id,
      eventType: "phone-call",
      atDay: 1,
    });
    expect(result.witnessActorIds).toEqual([trigger.id]);
    const lead = getLeadsByHolder(db, trigger.id)[0]!;
    expect(lead.counterpartyActorId).toBeNull();
    expect(lead.subjectEventType).toBe("phone-call");
  });

  it("respects maxWitnesses cap when a venue is crowded", () => {
    db = freshDB();
    const loc = insertLocation(db, { code: "x", displayName: "X" });
    const del = insertActor(db, { code: "del", firstName: "Del", shortName: "Del" });
    setActorLocation(db, del.id, loc.id);
    for (let i = 0; i < 5; i += 1) {
      const a = insertActor(db, { code: `w${i}`, firstName: `W${i}`, shortName: `W${i}` });
      setActorLocation(db, a.id, loc.id);
    }
    const result = seedWitnessLeads(db, {
      locationId: loc.id,
      principalActorId: del.id,
      eventType: "bribe",
      atDay: 1,
      maxWitnesses: 3,
    });
    expect(result.witnessActorIds.length).toBe(3);
  });
});
