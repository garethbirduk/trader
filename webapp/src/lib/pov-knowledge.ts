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
}

/**
 * Hook variant. Memoised on (dump, povActorId, day). Day-level
 * granularity is enough for the LHS list; sub-hour scrubbing doesn't
 * need to reshape it.
 */
export function useKnownIds(
  dump: RunDump,
  povActorId: number,
  day: number,
): KnownIds {
  const snapshot = useMemo<DaySnapshot | null>(
    () => dump.snapshots?.find((s) => s.day === day) ?? null,
    [dump.snapshots, day],
  );
  return useMemo(
    () => computeKnownIds(dump, povActorId, day, snapshot),
    [dump, povActorId, day, snapshot],
  );
}

function computeKnownIds(
  dump: RunDump,
  povActorId: number,
  day: number,
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

  // Event stream as of the end of `day` (inclusive). Earlier days are
  // included in full.
  const events = dump.events;
  for (const e of events) {
    if (e.at.day > day) continue;

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

  return { actors, itemKinds };
}
