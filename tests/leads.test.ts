import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import {
  decayLeads,
  deleteLead,
  getLeadById,
  getLeadsByHolder,
  insertLead,
  shareLead,
} from "../src/engine/leads/leads-repo.js";
import type { DB } from "../src/engine/core/db.js";

function setup(db: DB) {
  const del = insertActor(db, { code: "del", firstName: "Del", shortName: "Del" });
  const denzil = insertActor(db, { code: "denzil", firstName: "Denzil", shortName: "Denzil" });
  const monkey = insertActor(db, { code: "monkey", firstName: "Monkey Harris", shortName: "Monkey Harris" });
  const vacuums = insertItemKind(db, {
    code: "vacuums",
    displayName: "Vacuum cleaners",
    category: "electrical",
    baseValue: 30,
  });
  return { del, denzil, monkey, vacuums };
}

describe("leads repo", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("inserts and retrieves a lead with default confidence and zero hops", () => {
    db = freshDB();
    const { del, denzil, vacuums } = setup(db);
    const lead = insertLead(db, {
      holderActorId: del.id,
      side: "supply",
      subjectItemKindId: vacuums.id,
      counterpartyActorId: denzil.id,
      estimatedQuantity: 100,
      estimatedUnitPrice: 10,
      acquiredDay: 1,
    });
    expect(lead.confidence).toBe("warm");
    expect(lead.hopCount).toBe(0);
    expect(lead.subjectQualityTier).toBeNull();
    expect(getLeadById(db, lead.id)).toEqual(lead);
  });

  it("supports the 'a guy' shape — null counterparty", () => {
    db = freshDB();
    const { del, vacuums } = setup(db);
    const lead = insertLead(db, {
      holderActorId: del.id,
      side: "supply",
      subjectItemKindId: vacuums.id,
      estimatedQuantity: 50,
      estimatedUnitPrice: 8,
      acquiredDay: 1,
    });
    expect(lead.counterpartyActorId).toBeNull();
  });

  it("queries by holder", () => {
    db = freshDB();
    const { del, denzil, vacuums } = setup(db);
    insertLead(db, {
      holderActorId: del.id,
      side: "supply",
      subjectItemKindId: vacuums.id,
      counterpartyActorId: denzil.id,
      estimatedQuantity: 100,
      estimatedUnitPrice: 10,
      acquiredDay: 1,
    });
    insertLead(db, {
      holderActorId: del.id,
      side: "demand",
      subjectItemKindId: vacuums.id,
      counterpartyActorId: denzil.id,
      estimatedQuantity: 5,
      estimatedUnitPrice: 25,
      acquiredDay: 1,
    });
    insertLead(db, {
      holderActorId: denzil.id,
      side: "supply",
      subjectItemKindId: vacuums.id,
      estimatedQuantity: 200,
      estimatedUnitPrice: 9,
      acquiredDay: 1,
    });
    expect(getLeadsByHolder(db, del.id)).toHaveLength(2);
    expect(getLeadsByHolder(db, denzil.id)).toHaveLength(1);
  });

  it("decays warm leads to cold and deletes very old leads", () => {
    db = freshDB();
    const { del, denzil, vacuums } = setup(db);
    insertLead(db, {
      holderActorId: del.id,
      side: "supply",
      subjectItemKindId: vacuums.id,
      counterpartyActorId: denzil.id,
      estimatedQuantity: 1,
      estimatedUnitPrice: 1,
      acquiredDay: 1,
    });
    insertLead(db, {
      holderActorId: del.id,
      side: "supply",
      subjectItemKindId: vacuums.id,
      counterpartyActorId: denzil.id,
      estimatedQuantity: 1,
      estimatedUnitPrice: 1,
      acquiredDay: 5,
    });
    insertLead(db, {
      holderActorId: del.id,
      side: "supply",
      subjectItemKindId: vacuums.id,
      counterpartyActorId: denzil.id,
      estimatedQuantity: 1,
      estimatedUnitPrice: 1,
      acquiredDay: 10,
    });

    // today = 12. Thresholds: warm at 3, delete at 7.
    //   day-1  lead is 11 days old → deleted (>= 7)
    //   day-5  lead is  7 days old → deleted (>= 7)
    //   day-10 lead is  2 days old → still warm (< 3)
    const r = decayLeads(db, 12, 3, 7);
    expect(r.deleted).toBe(2);
    expect(r.cooled).toBe(0);
    expect(getLeadsByHolder(db, del.id).length).toBe(1);
    const remaining = getLeadsByHolder(db, del.id)[0]!;
    expect(remaining.confidence).toBe("warm");
  });

  it("decays a mid-aged lead to cold without deleting", () => {
    db = freshDB();
    const { del, denzil, vacuums } = setup(db);
    insertLead(db, {
      holderActorId: del.id,
      side: "supply",
      subjectItemKindId: vacuums.id,
      counterpartyActorId: denzil.id,
      estimatedQuantity: 1,
      estimatedUnitPrice: 1,
      acquiredDay: 5,
    });
    const r = decayLeads(db, /*today*/ 9, /*warm*/ 3, /*delete*/ 7);
    expect(r.cooled).toBe(1);
    expect(r.deleted).toBe(0);
    const remaining = getLeadsByHolder(db, del.id)[0]!;
    expect(remaining.confidence).toBe("cold");
  });

  it("rejects bad decay thresholds", () => {
    db = freshDB();
    expect(() => decayLeads(db, 1, 5, 5)).toThrow();
    expect(() => decayLeads(db, 1, 5, 4)).toThrow();
  });

  it("shareLead spawns a new lead with hop_count + 1, derived_from set", () => {
    db = freshDB();
    const { del, denzil, monkey, vacuums } = setup(db);
    const original = insertLead(db, {
      holderActorId: del.id,
      side: "supply",
      subjectItemKindId: vacuums.id,
      counterpartyActorId: denzil.id,
      estimatedQuantity: 100,
      estimatedUnitPrice: 10,
      acquiredDay: 1,
    });
    const shared = shareLead(db, del.id, monkey.id, original.id, 2);
    expect(shared.holderActorId).toBe(monkey.id);
    expect(shared.hopCount).toBe(1);
    expect(shared.derivedFromLeadId).toBe(original.id);
    expect(shared.sourceActorId).toBe(del.id);
    // Hopped leads are no longer warm — they're hearsay.
    expect(shared.confidence).toBe("cold");
    // Original is intact.
    expect(getLeadById(db, original.id)?.holderActorId).toBe(del.id);
  });

  it("rejects sharing a lead the holder doesn't have", () => {
    db = freshDB();
    const { del, denzil, monkey, vacuums } = setup(db);
    const lead = insertLead(db, {
      holderActorId: del.id,
      side: "supply",
      subjectItemKindId: vacuums.id,
      counterpartyActorId: denzil.id,
      estimatedQuantity: 1,
      estimatedUnitPrice: 1,
      acquiredDay: 1,
    });
    expect(() => shareLead(db, monkey.id, denzil.id, lead.id, 2)).toThrow();
    expect(() => shareLead(db, del.id, del.id, lead.id, 2)).toThrow();
  });

  it("deletes a lead", () => {
    db = freshDB();
    const { del, vacuums } = setup(db);
    const lead = insertLead(db, {
      holderActorId: del.id,
      side: "supply",
      subjectItemKindId: vacuums.id,
      estimatedQuantity: 1,
      estimatedUnitPrice: 1,
      acquiredDay: 1,
    });
    deleteLead(db, lead.id);
    expect(getLeadById(db, lead.id)).toBeNull();
  });
});
