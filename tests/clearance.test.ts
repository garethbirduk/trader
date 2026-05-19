import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import {
  getActorById,
  insertActor,
} from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { getStockLotsByOwner } from "../src/engine/stock/lots-repo.js";
import {
  insertLocation,
  setActorLocation,
} from "../src/engine/locations/locations.js";
import {
  bookClearance,
  getBookingsForListing,
  getClearanceListing,
  getOpenListings,
  insertClearanceListing,
} from "../src/engine/clearance/clearance-repo.js";
import { runDueClearances } from "../src/engine/clearance/run-clearance.js";
import { seedWitnessLeads } from "../src/engine/witness/seed-witness-leads.js";
import { getLeadsByHolder } from "../src/engine/leads/leads-repo.js";
import type { DB } from "../src/engine/core/db.js";

describe("house clearance", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("insertClearanceListing creates a listing + predetermined haul", () => {
    db = freshDB();
    const tables = insertItemKind(db, {
      code: "tables", displayName: "Tables", category: "furniture", baseValue: 40,
    });
    const lamps = insertItemKind(db, {
      code: "lamps", displayName: "Lamps", category: "furniture", baseValue: 28,
    });
    const { listing, lots } = insertClearanceListing(db, {
      listedDay: 1,
      scheduledDay: 2,
      fee: 500,
      flavour: "Mrs Smith's house",
      lots: [
        { itemKindId: tables.id, qualityTier: "good", quantity: 2 },
        { itemKindId: lamps.id, qualityTier: "fair", quantity: 1 },
      ],
    });
    expect(listing.scheduledDay).toBe(2);
    expect(listing.fee).toBe(500);
    expect(listing.flavour).toBe("Mrs Smith's house");
    expect(lots).toHaveLength(2);
    expect(getOpenListings(db).length).toBe(1);
  });

  it("first-come-first-served on scheduled_hour: earliest hour wins", () => {
    db = freshDB();
    const tables = insertItemKind(db, {
      code: "tables", displayName: "Tables", category: "furniture", baseValue: 40,
    });
    const winner = insertActor(db, {
      code: "winner", firstName: "Winner", shortName: "Winner", cash: 1000,
    });
    const loser = insertActor(db, {
      code: "loser", firstName: "Loser", shortName: "Loser", cash: 1000,
    });
    const { listing } = insertClearanceListing(db, {
      listedDay: 1, scheduledDay: 1, fee: 500,
      lots: [{ itemKindId: tables.id, qualityTier: "good", quantity: 3 }],
    });
    // Loser books 14:00; Winner books 13:00. Winner wins.
    bookClearance(db, {
      listingId: listing.id, bookerActorId: loser.id,
      bookedDay: 1, bookedHour: 10, scheduledHour: 14,
    });
    bookClearance(db, {
      listingId: listing.id, bookerActorId: winner.id,
      bookedDay: 1, bookedHour: 11, scheduledHour: 13,
    });

    const results = runDueClearances(db, { day: 1, hour: 13 });
    expect(results).toHaveLength(1);
    expect(results[0]!.winnerActorId).toBe(winner.id);
    // Winner now owns the tables.
    const winnerLots = getStockLotsByOwner(db, winner.id);
    expect(winnerLots).toHaveLength(1);
    expect(winnerLots[0]!.itemKindId).toBe(tables.id);
    expect(winnerLots[0]!.quantity).toBe(3);
    // Winner paid the fee.
    expect(getActorById(db, winner.id)!.cash).toBe(500);
    // Loser paid nothing (they showed up to nothing). Their booking
    // is marked arrived-empty.
    expect(getActorById(db, loser.id)!.cash).toBe(1000);
    const bookings = getBookingsForListing(db, listing.id);
    const winnerBooking = bookings.find((b) => b.bookerActorId === winner.id)!;
    const loserBooking = bookings.find((b) => b.bookerActorId === loser.id)!;
    expect(winnerBooking.outcome).toBe("won");
    expect(loserBooking.outcome).toBe("arrived-empty");
    // Listing is resolved.
    const resolved = getClearanceListing(db, listing.id);
    expect(resolved!.resolvedDay).toBe(1);
    expect(resolved!.winningBookingId).toBe(winnerBooking.id);
  });

  it("a clearance with no bookings stays open through its scheduled day", () => {
    db = freshDB();
    const tables = insertItemKind(db, {
      code: "tables", displayName: "Tables", category: "furniture", baseValue: 40,
    });
    const { listing } = insertClearanceListing(db, {
      listedDay: 1, scheduledDay: 1, fee: 500,
      lots: [{ itemKindId: tables.id, qualityTier: "good", quantity: 3 }],
    });
    const results = runDueClearances(db, { day: 1, hour: 20 });
    expect(results).toHaveLength(0);
    // Listing not yet resolved — still open for the next day's spawner
    // to clean up (out of scope for this primitive).
    const after = getClearanceListing(db, listing.id);
    expect(after!.resolvedDay).toBeNull();
  });

  it("double-booking the same listing as the same actor is blocked", () => {
    db = freshDB();
    const tables = insertItemKind(db, {
      code: "tables", displayName: "Tables", category: "furniture", baseValue: 40,
    });
    const actor = insertActor(db, { code: "a", firstName: "A", shortName: "A", cash: 1000 });
    const { listing } = insertClearanceListing(db, {
      listedDay: 1, scheduledDay: 1, fee: 500,
      lots: [{ itemKindId: tables.id, qualityTier: "good", quantity: 3 }],
    });
    const first = bookClearance(db, {
      listingId: listing.id, bookerActorId: actor.id,
      bookedDay: 1, bookedHour: 9, scheduledHour: 13,
    });
    expect(first.type).toBe("booked");
    const second = bookClearance(db, {
      listingId: listing.id, bookerActorId: actor.id,
      bookedDay: 1, bookedHour: 10, scheduledHour: 12,
    });
    expect(second.type).toBe("blocked");
  });

  it("scheduled hour in the future doesn't trigger early resolution", () => {
    db = freshDB();
    const tables = insertItemKind(db, {
      code: "tables", displayName: "Tables", category: "furniture", baseValue: 40,
    });
    const winner = insertActor(db, {
      code: "w", firstName: "W", shortName: "W", cash: 1000,
    });
    const { listing } = insertClearanceListing(db, {
      listedDay: 1, scheduledDay: 1, fee: 500,
      lots: [{ itemKindId: tables.id, qualityTier: "good", quantity: 3 }],
    });
    bookClearance(db, {
      listingId: listing.id, bookerActorId: winner.id,
      bookedDay: 1, bookedHour: 9, scheduledHour: 15,
    });
    // Hour 12 < scheduled 15 → no resolution yet.
    const r1 = runDueClearances(db, { day: 1, hour: 12 });
    expect(r1).toHaveLength(0);
    // Hour 15 → resolves.
    const r2 = runDueClearances(db, { day: 1, hour: 15 });
    expect(r2).toHaveLength(1);
    expect(r2[0]!.winnerActorId).toBe(winner.id);
  });
});

describe("clearance + witness integration", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("a booker's phone call at a venue plants witness leads for present bystanders", () => {
    db = freshDB();
    const pub = insertLocation(db, { code: "nags", displayName: "Nag's" });
    const del = insertActor(db, { code: "del", firstName: "Del", shortName: "Del" });
    const trigger = insertActor(db, { code: "trigger", firstName: "Trigger", shortName: "Trigger" });
    const boyce = insertActor(db, { code: "boyce", firstName: "Boyce", shortName: "Boyce" });
    setActorLocation(db, del.id, pub.id);
    setActorLocation(db, trigger.id, pub.id);
    setActorLocation(db, boyce.id, pub.id);

    const tables = insertItemKind(db, {
      code: "tables", displayName: "Tables", category: "furniture", baseValue: 40,
    });
    const { listing } = insertClearanceListing(db, {
      listedDay: 1, scheduledDay: 1, fee: 500,
      lots: [{ itemKindId: tables.id, qualityTier: "good", quantity: 3 }],
    });
    // Del books from the pub at 11:00. Trigger and Boyce overhear.
    bookClearance(db, {
      listingId: listing.id, bookerActorId: del.id,
      bookedDay: 1, bookedHour: 11, scheduledHour: 16,
      bookedAtLocationId: pub.id,
    });
    // The witness-seeding step is the caller's job — the booking
    // primitive records the location but doesn't auto-seed leads.
    // Composition test: caller does both.
    seedWitnessLeads(db, {
      locationId: pub.id,
      principalActorId: del.id,
      eventType: "clearance-booking",
      context: { listingId: listing.id, scheduledHour: 16 },
      atDay: 1,
    });
    const triggerLeads = getLeadsByHolder(db, trigger.id);
    expect(triggerLeads).toHaveLength(1);
    expect(triggerLeads[0]!.subjectEventType).toBe("clearance-booking");
    const ctx = JSON.parse(triggerLeads[0]!.subjectContextJson!);
    expect(ctx.listingId).toBe(listing.id);
    expect(ctx.scheduledHour).toBe(16);
  });
});
