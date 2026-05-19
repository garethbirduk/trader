import { useMemo } from "react";
import type { DaySnapshot, RunDump } from "../types.js";

/**
 * What does an actor know as of day D? (docs/ui.md §11.1 + §11.6 —
 * "Player-known entity filter" + "Witness state".) The engine doesn't
 * materialise witness state today, so we derive a conservative
 * approximation from the event stream:
 *
 *   • The actor themselves.
 *   • Anyone they've exchanged gossip with (sender / receiver) — and
 *     anyone *mentioned in* a lead they received (counterparty,
 *     subject-target).
 *   • Counterparties in any deal / pubdeal they were in.
 *   • The auction lots they have `knownAuctionLotIds` for (snapshot),
 *     and the actors / item-kinds attached to those lots.
 *
 * Per the user's instruction: "gossip is currently considered
 * knowledge."
 *
 * This is intentionally conservative — we err toward HIDING actors /
 * items rather than showing ones the POV actor has no plausible reason
 * to know about. Phase 5 / §11.1 will replace this with a proper
 * engine-side witness surface.
 *
 * Admin POV bypasses both filters and sees everything.
 */

export interface KnownIds {
  readonly actors: ReadonlySet<number>;
  readonly itemKinds: ReadonlySet<number>;
  /** Locations the POV knows about. Derived from known.actors: a venue
   *  is known if it's the home / lockup / current location of any actor
   *  the POV knows (POV themselves is always in `actors`, so their own
   *  home / lockup / current location are always present). */
  readonly locations: ReadonlySet<number>;
  /** Per-acquainted-actor, where POV believes they are at the cursor
   *  (day, hour). Sources in confidence order: self / pair-sync / routine
   *  (only at fixed-hour slots). Acquainted actors whose only signal is
   *  a flex-hour routine entry are *absent* from this map — POV knows
   *  the person but has no confident position read this hour. */
  readonly believedLocations: ReadonlyMap<number, number>;
}

/**
 * Hook variant. Memoised on (dump, povActorId, day, hour). Knowledge is
 * computed from events strictly before the cursor — at D1 H00 nothing
 * from today has happened yet, so the POV knows only what was true at
 * end-of-D0.
 */
export function useKnownIds(
  dump: RunDump,
  povActorId: number,
  day: number,
  hour: number,
): KnownIds {
  const snapshot = useMemo<DaySnapshot | null>(
    () => dump.snapshots?.find((s) => s.day === day) ?? null,
    [dump.snapshots, day],
  );
  return useMemo(
    () => computeKnownIds(dump, povActorId, day, hour, snapshot),
    [dump, povActorId, day, hour, snapshot],
  );
}

function computeKnownIds(
  dump: RunDump,
  povActorId: number,
  day: number,
  hour: number,
  snapshot: DaySnapshot | null,
): KnownIds {
  const actors = new Set<number>();
  const itemKinds = new Set<number>();

  // Seed: self + own stock + own home/current location's proprietor.
  actors.add(povActorId);
  const povActor = dump.actors.find((a) => a.id === povActorId);

  if (snapshot !== null) {
    for (const lot of snapshot.stockLots) {
      if (lot.ownerActorId === povActorId) {
        itemKinds.add(lot.itemKindId);
      }
    }

    // Auction-lot knowledge (engine-materialised on the snapshot).
    const snapActor = snapshot.actors.find((a) => a.id === povActorId);
    const knownLotIds = new Set<number>(snapActor?.knownAuctionLotIds ?? []);
    for (const lot of snapshot.auctionLots) {
      if (knownLotIds.has(lot.id)) {
        itemKinds.add(lot.itemKindId);
        if (lot.clearedToActorId !== null) actors.add(lot.clearedToActorId);
      }
    }
  }

  // Household: actors sharing the POV actor's home location count as
  // known. ("You know who lives under your roof.")
  if (povActor !== undefined && povActor.homeLocationId !== null && povActor.homeLocationId !== undefined) {
    const home = povActor.homeLocationId;
    for (const a of dump.actors) {
      if (a.homeLocationId === home) actors.add(a.id);
    }
  }

  // Dealer fraternity: every dealer knows every other dealer (and
  // by extension where they live — locations are unfiltered, so the
  // dealer's home venue just shows them in its "Lives here" list).
  // Mirrors the real-world scene where the trading network is a
  // small known club, not something each dealer has to discover.
  if (povActor !== undefined && povActor.roles?.includes("dealer")) {
    for (const a of dump.actors) {
      if (a.roles?.includes("dealer")) actors.add(a.id);
    }
  }

  // Household transitive closure: if you know anyone who lives at
  // home X, you know everyone who lives at home X. (Trigger knows
  // Del → Trigger knows Del's housemates Rodney and Uncle Albert;
  // Boyce knows Denzil → Boyce knows Corrine.) Applied after the
  // dealer fraternity so dealer homes are all walked.
  const knownHomes = new Set<number>();
  for (const id of actors) {
    const a = dump.actors.find((x) => x.id === id);
    if (a !== undefined && a.homeLocationId !== null && a.homeLocationId !== undefined) {
      knownHomes.add(a.homeLocationId);
    }
  }
  for (const a of dump.actors) {
    if (a.homeLocationId !== null && a.homeLocationId !== undefined && knownHomes.has(a.homeLocationId)) {
      actors.add(a.id);
    }
  }

  // Event stream strictly before the (day, hour) cursor. At hour 0 of a
  // given day, no events from that day have fired yet — so the POV's
  // knowledge reflects end-of-previous-day.
  const events = dump.events;
  for (const e of events) {
    if (e.at.day > day) continue;
    if (e.at.day === day && e.at.hour >= hour) continue;

    if (e.type === "gossip.exchanged") {
      // Anyone the POV actor was a party to a gossip exchange with —
      // sender, receiver, or named in a lead they received.
      const participants = (e.participantActorIds as readonly number[] | undefined) ?? [];
      const involves = participants.includes(povActorId);
      if (!involves) continue;
      for (const p of participants) actors.add(p);
      const exchanges = (e.exchanges as readonly {
        fromActorId: number;
        toActorId: number;
        lead: {
          subjectItemKindId: number | null;
          subjectTargetActorId: number | null;
          counterpartyActorId: number | null;
        };
      }[] | undefined) ?? [];
      for (const x of exchanges) {
        // POV picks up subjects of leads they receive.
        if (x.toActorId !== povActorId) continue;
        const l = x.lead;
        if (l.subjectItemKindId !== null) itemKinds.add(l.subjectItemKindId);
        if (l.subjectTargetActorId !== null) actors.add(l.subjectTargetActorId);
        if (l.counterpartyActorId !== null) actors.add(l.counterpartyActorId);
      }
      continue;
    }

    if (
      e.type === "pubdeal.attempted" ||
      e.type === "pubdeal.agreed" ||
      e.type === "pubdeal.walked" ||
      e.type === "pubdeal.skipped-too-small"
    ) {
      const seller = e.sellerActorId as number | undefined;
      const buyer = e.buyerActorId as number | undefined;
      const itemKindId = e.itemKindId as number | undefined;
      if (seller === povActorId || buyer === povActorId) {
        if (typeof seller === "number") actors.add(seller);
        if (typeof buyer === "number") actors.add(buyer);
        if (typeof itemKindId === "number") itemKinds.add(itemKindId);
      }
      continue;
    }

    if (
      e.type === "deal.settled" ||
      e.type === "deal.agreed" ||
      e.type === "deal.defaulted"
    ) {
      const seller = e.sellerActorId as number | undefined;
      const buyer = e.buyerActorId as number | undefined;
      if (seller === povActorId || buyer === povActorId) {
        if (typeof seller === "number") actors.add(seller);
        if (typeof buyer === "number") actors.add(buyer);
        // Pull item-kinds off the deal record in any snapshot through
        // today (deal lines live on the snapshot, not the event).
        const dealId = e.dealId as number | undefined;
        if (typeof dealId === "number" && snapshot !== null) {
          const deal = snapshot.deals.find((d) => d.id === dealId);
          if (deal !== undefined) {
            for (const line of deal.lines) itemKinds.add(line.itemKindId);
          }
        }
      }
      continue;
    }

    if (
      e.type === "market.lot-sold" ||
      e.type === "market.lot-listed"
    ) {
      const seller = e.sellerActorId as number | undefined;
      const buyer = e.buyerActorId as number | undefined;
      const itemKindId = e.itemKindId as number | undefined;
      if (seller === povActorId || buyer === povActorId) {
        if (typeof seller === "number") actors.add(seller);
        if (typeof buyer === "number") actors.add(buyer);
        if (typeof itemKindId === "number") itemKinds.add(itemKindId);
      }
      continue;
    }
  }

  // Derive locations from known actors. A venue is known iff some known
  // actor: (a) has it as their home, (b) is currently there, or (c) has
  // it in their routine (weekday or weekend). Routine coverage matters
  // most — it pulls in Nag's via Mike, Sid's via Sid, auction-house via
  // dealers' work hours, etc., without needing the POV to have heard
  // specific gossip about those venues. POV themselves is always in
  // `actors`, so POV's own venues land here without a special case.
  const locations = new Set<number>();
  const snapActorById = new Map<number, { currentLocationId: number | null }>();
  if (snapshot !== null) {
    for (const a of snapshot.actors) {
      snapActorById.set(a.id, { currentLocationId: a.currentLocationId });
    }
  }
  const routinesByActorId = new Map<number, (typeof dump.actorRoutines extends undefined ? never : NonNullable<typeof dump.actorRoutines>)[number]>();
  for (const r of dump.actorRoutines ?? []) {
    routinesByActorId.set(r.actorId, r);
  }
  for (const id of actors) {
    const a = dump.actors.find((x) => x.id === id);
    if (a === undefined) continue;
    if (a.homeLocationId !== null) locations.add(a.homeLocationId);
    const cur = snapActorById.get(id)?.currentLocationId;
    if (cur !== null && cur !== undefined) locations.add(cur);
    const r = routinesByActorId.get(id);
    if (r !== undefined) {
      for (const entry of r.schedule) locations.add(entry.locationId);
      for (const entry of r.weekendSchedule ?? []) locations.add(entry.locationId);
    }
  }

  // Calendar knowledge: for each acquainted actor, where does POV
  // believe they are at the cursor (day, hour)?
  //   1) Self → POV's own current location.
  //   2) Pair-sync partners → partner's actual currentLocationId.
  //   3) Routine, but only at non-flexible hours. Flex hours are
  //      "low-confidence guess at home", which we drop entirely.
  // Weekend schedule overrides weekday when present (matches engine).
  const believedLocations = new Map<number, number>();
  const partners = new Set<number>();
  for (const [a, b] of dump.pairs ?? []) {
    if (a === povActorId) partners.add(b);
    else if (b === povActorId) partners.add(a);
  }
  const povCur = snapActorById.get(povActorId)?.currentLocationId;
  if (povCur !== null && povCur !== undefined) {
    believedLocations.set(povActorId, povCur);
  }
  const useWeekendSchedule = isWeekendDay(day);
  for (const id of actors) {
    if (id === povActorId) continue;
    if (partners.has(id)) {
      const cur = snapActorById.get(id)?.currentLocationId;
      if (cur !== null && cur !== undefined) {
        believedLocations.set(id, cur);
      }
      continue;
    }
    const r = routinesByActorId.get(id);
    if (r === undefined) continue;
    const flex = new Set(r.flexibleHours ?? []);
    if (flex.has(hour)) continue;
    const src =
      useWeekendSchedule && r.weekendSchedule !== undefined
        ? r.weekendSchedule
        : r.schedule;
    const entry = src.find((e) => e.hour === hour);
    if (entry !== undefined) believedLocations.set(id, entry.locationId);
  }

  return { actors, itemKinds, locations, believedLocations };
}

/** Day-of-week 1=Mon..7=Sun → weekend = Sat (6) or Sun (7). Matches
 *  `isWeekend` from `lib/calendar.ts`; kept local to avoid pulling the
 *  whole calendar module into this file's dependency chain. */
function isWeekendDay(day: number): boolean {
  const dow = ((day - 1) % 7) + 1;
  return dow === 6 || dow === 7;
}
