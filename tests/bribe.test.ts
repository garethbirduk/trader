import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import {
  getActorById,
  insertActor,
} from "../src/engine/actors/actors-repo.js";
import {
  insertLocation,
  setActorLocation,
} from "../src/engine/locations/locations.js";
import { offerBribe } from "../src/engine/world/bribe.js";
import { getLeadsByHolder } from "../src/engine/leads/leads-repo.js";
import { createEventLog } from "../src/engine/core/events.js";
import type { DB } from "../src/engine/core/db.js";
import type { WorldEvent } from "../src/engine/core/events.js";

describe("offerBribe primitive", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("a bribable officer accepts an above-threshold offer, cash flows to them", () => {
    db = freshDB();
    const market = insertLocation(db, { code: "m", displayName: "Market" });
    const del = insertActor(db, { code: "del", firstName: "Del", shortName: "Del", cash: 500 });
    const slater = insertActor(db, {
      code: "slater", firstName: "Slater", shortName: "Slater", cash: 100, bribable: true,
    });
    const events: WorldEvent[] = [];
    const log = createEventLog();
    log.subscribe((e) => events.push(e));

    const result = offerBribe(db, { day: 1, hour: 12 }, {
      offererActorId: del.id,
      officerActorId: slater.id,
      amount: 50,
      baseThreshold: 40,
      locationId: market.id,
      atDay: 1,
      events: log,
    });
    expect(result.type).toBe("accepted");
    if (result.type !== "accepted") throw new Error();
    expect(getActorById(db, del.id)!.cash).toBe(450);
    expect(getActorById(db, slater.id)!.cash).toBe(150);
    expect(events.filter((e) => e.type === "bribe.accepted")).toHaveLength(1);
    expect(events.filter((e) => e.type === "bribe.offered")).toHaveLength(1);
  });

  it("a non-bribable officer refuses, no cash moves, refusal event emitted", () => {
    db = freshDB();
    const market = insertLocation(db, { code: "m", displayName: "Market" });
    const del = insertActor(db, { code: "del", firstName: "Del", shortName: "Del", cash: 500 });
    const cop = insertActor(db, {
      code: "cop", firstName: "Honest Cop", shortName: "Honest Cop", cash: 100,
      // default bribable=false
    });
    const events: WorldEvent[] = [];
    const log = createEventLog();
    log.subscribe((e) => events.push(e));

    const result = offerBribe(db, { day: 1, hour: 12 }, {
      offererActorId: del.id,
      officerActorId: cop.id,
      amount: 200,
      baseThreshold: 40,
      locationId: market.id,
      atDay: 1,
      events: log,
    });
    expect(result.type).toBe("refused");
    if (result.type !== "refused") throw new Error();
    expect(result.reason).toBe("not-bribable");
    expect(getActorById(db, del.id)!.cash).toBe(500);
    expect(getActorById(db, cop.id)!.cash).toBe(100);
    expect(events.filter((e) => e.type === "bribe.refused")).toHaveLength(1);
  });

  it("a below-threshold offer is refused even by a bribable officer", () => {
    db = freshDB();
    const market = insertLocation(db, { code: "m", displayName: "Market" });
    const del = insertActor(db, { code: "del", firstName: "Del", shortName: "Del", cash: 500 });
    const slater = insertActor(db, {
      code: "slater", firstName: "Slater", shortName: "Slater", cash: 1000, bribable: true,
    });
    // threshold = 40 * (1 + 1000/1000) = 80 — offer of 50 fails.
    const result = offerBribe(db, { day: 1, hour: 12 }, {
      offererActorId: del.id,
      officerActorId: slater.id,
      amount: 50,
      baseThreshold: 40,
      locationId: market.id,
      atDay: 1,
    });
    expect(result.type).toBe("refused");
    if (result.type !== "refused") throw new Error();
    expect(result.reason).toBe("below-threshold");
    expect(getActorById(db, del.id)!.cash).toBe(500); // no charge
  });

  it("accepted bribe seeds witness leads on present bystanders", () => {
    db = freshDB();
    const market = insertLocation(db, { code: "m", displayName: "Market" });
    const del = insertActor(db, { code: "del", firstName: "Del", shortName: "Del", cash: 500 });
    const slater = insertActor(db, {
      code: "slater", firstName: "Slater", shortName: "Slater", cash: 100, bribable: true,
    });
    const trigger = insertActor(db, {
      code: "trigger", firstName: "Trigger", shortName: "Trigger", cash: 0,
    });
    setActorLocation(db, del.id, market.id);
    setActorLocation(db, slater.id, market.id);
    setActorLocation(db, trigger.id, market.id);

    offerBribe(db, { day: 1, hour: 12 }, {
      offererActorId: del.id,
      officerActorId: slater.id,
      amount: 50,
      baseThreshold: 40,
      locationId: market.id,
      atDay: 1,
      eventTag: "bribe-bust-waiver",
      context: { scenario: "market-adhoc-bust" },
    });
    const leads = getLeadsByHolder(db, trigger.id);
    expect(leads).toHaveLength(1);
    expect(leads[0]!.kind).toBe("rep");
    expect(leads[0]!.subjectTargetActorId).toBe(del.id);
    expect(leads[0]!.counterpartyActorId).toBe(slater.id);
    expect(leads[0]!.subjectEventType).toBe("bribe-bust-waiver");
    expect(leads[0]!.estimatedUnitPrice).toBe(50);
  });

  it("blocks when offerer can't afford the amount", () => {
    db = freshDB();
    const market = insertLocation(db, { code: "m", displayName: "Market" });
    const broke = insertActor(db, { code: "broke", firstName: "Broke", shortName: "Broke", cash: 5 });
    const slater = insertActor(db, {
      code: "slater", firstName: "Slater", shortName: "Slater", cash: 0, bribable: true,
    });
    const result = offerBribe(db, { day: 1, hour: 12 }, {
      offererActorId: broke.id,
      officerActorId: slater.id,
      amount: 50,
      baseThreshold: 40,
      locationId: market.id,
      atDay: 1,
    });
    expect(result.type).toBe("blocked");
  });
});
