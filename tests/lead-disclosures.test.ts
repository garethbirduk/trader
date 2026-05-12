import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import {
  getActorById,
  insertActor,
} from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertLead } from "../src/engine/leads/leads-repo.js";
import {
  isLeadDisclosedTo,
  payForLeadDetails,
  recordLeadDisclosure,
  redactLeadForViewer,
} from "../src/engine/leads/disclosures-repo.js";
import type { DB } from "../src/engine/core/db.js";

describe("lead disclosures (two-tier gossip)", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("holder sees their own lead in full without a disclosure row", () => {
    db = freshDB();
    const holder = insertActor(db, { code: "h", displayName: "H" });
    const item = insertItemKind(db, {
      code: "x", displayName: "X", category: "tools", baseValue: 10,
    });
    const lead = insertLead(db, {
      holderActorId: holder.id,
      side: "supply",
      subjectItemKindId: item.id,
      estimatedQuantity: 50,
      estimatedUnitPrice: 12,
      acquiredDay: 1,
    });
    const view = redactLeadForViewer(db, lead, holder.id);
    expect(view.tier).toBe("detail");
    if (view.tier === "detail") {
      expect(view.lead.estimatedQuantity).toBe(50);
    }
  });

  it("non-holder sees headline only by default", () => {
    db = freshDB();
    const holder = insertActor(db, { code: "h", displayName: "H" });
    const viewer = insertActor(db, { code: "v", displayName: "V" });
    const item = insertItemKind(db, {
      code: "x", displayName: "X", category: "tools", baseValue: 10,
    });
    const lead = insertLead(db, {
      holderActorId: holder.id,
      side: "supply",
      subjectItemKindId: item.id,
      estimatedQuantity: 50,
      estimatedUnitPrice: 12,
      acquiredDay: 1,
    });
    const view = redactLeadForViewer(db, lead, viewer.id);
    expect(view.tier).toBe("headline");
    if (view.tier === "headline") {
      expect(view.headline.subjectItemKindId).toBe(item.id);
      expect(view.headline.kind).toBe("commodity");
      // Headline doesn't carry qty / price / hop / confidence.
      expect((view.headline as Record<string, unknown>).estimatedQuantity).toBeUndefined();
    }
  });

  it("payForLeadDetails transfers cash and records disclosure", () => {
    db = freshDB();
    const holder = insertActor(db, { code: "h", displayName: "H" });
    const asker = insertActor(db, { code: "a", displayName: "A", cash: 100 });
    const item = insertItemKind(db, {
      code: "x", displayName: "X", category: "tools", baseValue: 10,
    });
    const lead = insertLead(db, {
      holderActorId: holder.id,
      side: "supply",
      subjectItemKindId: item.id,
      estimatedQuantity: 50,
      estimatedUnitPrice: 12,
      acquiredDay: 1,
    });
    const result = payForLeadDetails(db, {
      askerActorId: asker.id,
      holderActorId: holder.id,
      leadId: lead.id,
      fee: 3,
      atDay: 2,
    });
    expect(result.type).toBe("disclosed");
    expect(getActorById(db, asker.id)!.cash).toBe(97);
    expect(getActorById(db, holder.id)!.cash).toBe(3);
    expect(isLeadDisclosedTo(db, lead.id, asker.id)).toBe(true);

    // Asker now sees the lead in full.
    const view = redactLeadForViewer(db, lead, asker.id);
    expect(view.tier).toBe("detail");
  });

  it("payForLeadDetails is idempotent — second call doesn't double-charge", () => {
    db = freshDB();
    const holder = insertActor(db, { code: "h", displayName: "H" });
    const asker = insertActor(db, { code: "a", displayName: "A", cash: 100 });
    const item = insertItemKind(db, {
      code: "x", displayName: "X", category: "tools", baseValue: 10,
    });
    const lead = insertLead(db, {
      holderActorId: holder.id,
      side: "supply",
      subjectItemKindId: item.id,
      estimatedQuantity: 50,
      estimatedUnitPrice: 12,
      acquiredDay: 1,
    });
    payForLeadDetails(db, {
      askerActorId: asker.id, holderActorId: holder.id, leadId: lead.id,
      fee: 3, atDay: 2,
    });
    const second = payForLeadDetails(db, {
      askerActorId: asker.id, holderActorId: holder.id, leadId: lead.id,
      fee: 3, atDay: 5,
    });
    expect(second.type).toBe("disclosed");
    if (second.type === "disclosed") {
      expect(second.alreadyKnew).toBe(true);
    }
    expect(getActorById(db, asker.id)!.cash).toBe(97); // only one charge
  });

  it("blocks asker who can't afford the fee", () => {
    db = freshDB();
    const holder = insertActor(db, { code: "h", displayName: "H" });
    const asker = insertActor(db, { code: "a", displayName: "A", cash: 1 });
    const item = insertItemKind(db, {
      code: "x", displayName: "X", category: "tools", baseValue: 10,
    });
    const lead = insertLead(db, {
      holderActorId: holder.id,
      side: "supply",
      subjectItemKindId: item.id,
      estimatedQuantity: 50,
      estimatedUnitPrice: 12,
      acquiredDay: 1,
    });
    const result = payForLeadDetails(db, {
      askerActorId: asker.id, holderActorId: holder.id, leadId: lead.id,
      fee: 3, atDay: 2,
    });
    expect(result.type).toBe("blocked");
    expect(isLeadDisclosedTo(db, lead.id, asker.id)).toBe(false);
  });

  it("recordLeadDisclosure direct write also unlocks the lead", () => {
    db = freshDB();
    const holder = insertActor(db, { code: "h", displayName: "H" });
    const viewer = insertActor(db, { code: "v", displayName: "V" });
    const item = insertItemKind(db, {
      code: "x", displayName: "X", category: "tools", baseValue: 10,
    });
    const lead = insertLead(db, {
      holderActorId: holder.id, side: "supply",
      subjectItemKindId: item.id,
      estimatedQuantity: 50, estimatedUnitPrice: 12, acquiredDay: 1,
    });
    // E.g. a witness-event handler grants free disclosure.
    recordLeadDisclosure(db, {
      leadId: lead.id, actorId: viewer.id, revealedAtDay: 1, costPaid: 0,
    });
    const view = redactLeadForViewer(db, lead, viewer.id);
    expect(view.tier).toBe("detail");
  });
});
