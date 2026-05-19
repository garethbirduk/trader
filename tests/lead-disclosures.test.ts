import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertLead } from "../src/engine/leads/leads-repo.js";
import {
  getDisclosuresForActor,
  recordLeadDisclosure,
} from "../src/engine/leads/disclosures-repo.js";
import type { DB } from "../src/engine/core/db.js";

/**
 * `lead_disclosures` is the audit log for paid detail-unlock events
 * (Model B two-tier gossip). Visibility itself lives on
 * `leads.detail_unlocked` — this table records the history of who
 * paid, when, and to whom.
 */
describe("lead disclosures (audit log)", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("records a disclosure row with all fields", () => {
    db = freshDB();
    const asker = insertActor(db, { code: "a", firstName: "A", shortName: "A" });
    const partner = insertActor(db, { code: "p", firstName: "P", shortName: "P" });
    const item = insertItemKind(db, {
      code: "x", displayName: "X", category: "tools", baseValue: 10,
    });
    const lead = insertLead(db, {
      holderActorId: asker.id,
      side: "supply",
      subjectItemKindId: item.id,
      estimatedQuantity: 50,
      estimatedUnitPrice: 12,
      acquiredDay: 1,
    });

    const row = recordLeadDisclosure(db, {
      leadId: lead.id,
      actorId: asker.id,
      revealedAtDay: 3,
      revealedByActorId: partner.id,
      costPaid: 300,
    });
    expect(row.leadId).toBe(lead.id);
    expect(row.actorId).toBe(asker.id);
    expect(row.revealedAtDay).toBe(3);
    expect(row.revealedByActorId).toBe(partner.id);
    expect(row.costPaid).toBe(300);

    const all = getDisclosuresForActor(db, asker.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.leadId).toBe(lead.id);
  });

  it("is idempotent on (leadId, actorId)", () => {
    db = freshDB();
    const asker = insertActor(db, { code: "a", firstName: "A", shortName: "A" });
    const partner = insertActor(db, { code: "p", firstName: "P", shortName: "P" });
    const item = insertItemKind(db, {
      code: "x", displayName: "X", category: "tools", baseValue: 10,
    });
    const lead = insertLead(db, {
      holderActorId: asker.id,
      side: "supply",
      subjectItemKindId: item.id,
      estimatedQuantity: 50,
      estimatedUnitPrice: 12,
      acquiredDay: 1,
    });
    recordLeadDisclosure(db, {
      leadId: lead.id, actorId: asker.id, revealedAtDay: 3,
      revealedByActorId: partner.id, costPaid: 300,
    });
    // Second write must not duplicate or overwrite (idempotent).
    recordLeadDisclosure(db, {
      leadId: lead.id, actorId: asker.id, revealedAtDay: 5,
      revealedByActorId: partner.id, costPaid: 999,
    });
    const all = getDisclosuresForActor(db, asker.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.revealedAtDay).toBe(3);
    expect(all[0]!.costPaid).toBe(300);
  });
});
