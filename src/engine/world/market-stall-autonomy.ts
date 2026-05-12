import type { World, Unsubscribe } from "../core/world.js";
import { adjustActorCash, getActorById } from "../actors/actors-repo.js";
import { getActorsAtLocation } from "../locations/locations.js";
import {
  decrementLotQuantity,
  getStockLotsByOwner,
} from "../stock/lots-repo.js";
import {
  getAdhocStallsAt,
  getStallForToday,
  getUnresolvedBusted,
  insertStall,
  resolveStall,
  stampPatrolArrived,
  type MarketStall,
} from "../market/stalls-repo.js";
import { offerBribe } from "./bribe.js";

/**
 * Market stall mode + Slater patrol autonomy (todolist #3 + #4).
 *
 * Three handlers compose the full daily beat:
 *
 *   1. Stall registration. At each market-open hour, eligible sellers
 *      present at the market with stock register a stall for the
 *      day. NPCs default to LEGIT when they have enough cash to
 *      cover the fee × multiplier, else ADHOC. (Player UI can pick
 *      either explicitly — autonomy only runs for NPCs.)
 *
 *   2. Slater patrol. At each market-open hour, roll a per-hour
 *      patrol chance. If Slater arrives:
 *        a) Find adhoc stalls at the market today.
 *        b) For each, stamp patrol_arrived_hour.
 *        c) Each adhoc seller has the option to bribe — autonomy
 *           rolls bribeWillingness; on success they offer
 *           `bribeAmount` (scaling with their cash). If accepted,
 *           the stall flips to 'bribed' and witness leads fire.
 *        d) Unresolved sellers face the bust at the next-hour pass.
 *
 *   3. Bust resolution. Each market-open hour, find adhoc stalls
 *      whose patrol arrived in a PRIOR hour AND aren't resolved.
 *      They get busted: stock at the market is confiscated, a fine
 *      is paid, stall is marked 'busted'. (The location override —
 *      "taken to the nick for the day" — is a follow-up; for now
 *      the cash and stock fallout are the bite.)
 */
export interface MarketStallAutonomyOptions {
  /** Market location. */
  readonly marketLocationId: number;
  /** Hours the market is open — patrol + busts only fire here. */
  readonly marketOpenHours: readonly number[];
  /** Actor ids eligible to register a stall. Same set as marketSellers. */
  readonly sellerActorIds: ReadonlySet<number>;
  /** Stall fee charged on legit mode. Default £20. */
  readonly stallFee?: number;
  /** Multiplier on stallFee that the NPC must clear in cash before
   *  EVER going legit. Below this they're always adhoc. Default 5. */
  readonly legitCashMultiplier?: number;
  /** Even when a seller can afford legit, this is the chance they
   *  pick adhoc anyway — risk-takers, lazy with the £20, or holding
   *  hot stock. Default 0.35. Set to 0 to make affordability fully
   *  determine the choice. */
  readonly adhocChanceWhenAffordable?: number;
  /** Fine charged on bust. Default £50. */
  readonly busFine?: number;
  /** Slater (or whoever is patrolling). The bribe primitive checks
   *  their bribable flag; if absent, bribes always refuse. */
  readonly patrolOfficerActorId: number;
  /** Where bust proceeds flow. */
  readonly fineProceedsActorId: number;
  /** Per-hour probability that the patrol arrives. Default 0.15. */
  readonly patrolChancePerHour?: number;
  /** Per-stall probability that an adhoc seller offers a bribe on
   *  Slater's arrival. Default 0.6 — most try, some panic. */
  readonly bribeWillingness?: number;
  /** Bribe-amount-as-fraction-of-seller-cash. Default 0.1. */
  readonly bribeFractionOfCash?: number;
  /** Base bribe threshold passed to the bribe primitive. Default £40. */
  readonly bribeBaseThreshold?: number;
}

export function registerMarketStallAutonomy(
  world: World,
  opts: MarketStallAutonomyOptions,
): Unsubscribe[] {
  const stallFee = opts.stallFee ?? 20;
  const legitCashMult = opts.legitCashMultiplier ?? 5;
  const adhocChanceWhenAffordable = opts.adhocChanceWhenAffordable ?? 0.35;
  const busFine = opts.busFine ?? 50;
  const patrolChance = opts.patrolChancePerHour ?? 0.15;
  const bribeWilling = opts.bribeWillingness ?? 0.6;
  const bribeFracCash = opts.bribeFractionOfCash ?? 0.1;
  const bribeBaseThreshold = opts.bribeBaseThreshold ?? 40;
  const openSet = new Set(opts.marketOpenHours);

  // 1. Stall registration.
  const onRegister = world.onHour((clock) => {
    if (!openSet.has(clock.hour)) return;
    const present = getActorsAtLocation(world.db, opts.marketLocationId);
    for (const actorId of present) {
      if (!opts.sellerActorIds.has(actorId)) continue;
      const existing = getStallForToday(
        world.db,
        actorId,
        opts.marketLocationId,
        clock.day,
      );
      if (existing) continue;
      const actor = getActorById(world.db, actorId);
      if (!actor) continue;
      // Must actually have stock with them (or accessible) — a
      // dealer who turns up empty-handed doesn't run a stall.
      const allLots = getStockLotsByOwner(world.db, actorId);
      const totalUnits = allLots.reduce((s, l) => s + l.quantity, 0);
      if (totalUnits === 0) continue;

      // NPC pick: forced adhoc if they can't afford the fee × buffer.
      // Otherwise a coin-roll: most cash-rich dealers go legit but
      // some always chance the adhoc route.
      const canAffordLegit = actor.cash >= stallFee * legitCashMult;
      const mode: "legit" | "adhoc" = canAffordLegit
        ? world.rng.chance(adhocChanceWhenAffordable)
          ? "adhoc"
          : "legit"
        : "adhoc";
      const feePaid = mode === "legit" ? stallFee : 0;
      if (mode === "legit" && feePaid > 0) {
        adjustActorCash(world.db, actorId, -feePaid);
        adjustActorCash(world.db, opts.fineProceedsActorId, feePaid);
      }
      const stall = insertStall(world.db, {
        sellerActorId: actorId,
        locationId: opts.marketLocationId,
        day: clock.day,
        mode,
        feePaid,
      });
      world.events.emit({
        type: "market.stall-rented",
        at: clock,
        stallId: stall.id,
        sellerActorId: actorId,
        locationId: opts.marketLocationId,
        mode,
        feePaid,
      });
    }
  });

  // 2. Slater patrol + bribe resolution.
  const onPatrol = world.onHour((clock) => {
    if (!openSet.has(clock.hour)) return;
    // The patrolling officer must be physically at the market. The
    // skin's routine moves Slater between the nick and the market;
    // the patrol only fires when he's actually present.
    const present = getActorsAtLocation(world.db, opts.marketLocationId);
    if (!present.includes(opts.patrolOfficerActorId)) return;

    if (!world.rng.chance(patrolChance)) return;

    // Only act on stalls that haven't already had the patrol turn up
    // — once Slater has shown his face at a stall, the bribe-or-bust
    // window opens and subsequent patrol rolls don't restart it.
    const adhoc = getAdhocStallsAt(world.db, opts.marketLocationId, clock.day)
      .filter((s) => s.patrolArrivedHour === null);
    if (adhoc.length === 0) return;

    // Stamp arrival on every adhoc stall.
    for (const stall of adhoc) stampPatrolArrived(world.db, stall.id, clock.hour);
    world.events.emit({
      type: "market.patrol-arrived",
      at: clock,
      locationId: opts.marketLocationId,
      officerActorId: opts.patrolOfficerActorId,
      stallIds: adhoc.map((s) => s.id),
    });

    // Each seller decides: bribe or sit.
    for (const stall of adhoc) {
      if (!world.rng.chance(bribeWilling)) continue;
      const seller = getActorById(world.db, stall.sellerActorId);
      if (!seller) continue;
      const offer = Math.max(
        bribeBaseThreshold,
        Math.round(seller.cash * bribeFracCash),
      );
      if (seller.cash < offer) continue;
      const result = offerBribe(world.db, clock, {
        offererActorId: stall.sellerActorId,
        officerActorId: opts.patrolOfficerActorId,
        amount: offer,
        baseThreshold: bribeBaseThreshold,
        locationId: opts.marketLocationId,
        atDay: clock.day,
        events: world.events,
        eventTag: "bribe-bust-waiver",
        context: { stallId: stall.id },
      });
      if (result.type === "accepted") {
        resolveStall(world.db, {
          stallId: stall.id,
          mode: "bribed",
          hour: clock.hour,
          bribePaid: offer,
        });
        world.events.emit({
          type: "market.stall-bribed",
          at: clock,
          stallId: stall.id,
          sellerActorId: stall.sellerActorId,
          locationId: opts.marketLocationId,
          officerActorId: opts.patrolOfficerActorId,
          bribeAmount: offer,
        });
      }
    }
  });

  // 3. Bust resolution. At each open hour, sellers stamped in a
  // previous hour who didn't bribe/clear get busted now.
  const onBust = world.onHour((clock) => {
    if (!openSet.has(clock.hour)) return;
    const busted = getUnresolvedBusted(
      world.db,
      opts.marketLocationId,
      clock.day,
      clock.hour,
    );
    for (const stall of busted) {
      bustStall({
        world,
        clock,
        stall,
        fine: busFine,
        marketLocationId: opts.marketLocationId,
        officerActorId: opts.patrolOfficerActorId,
        fineProceedsActorId: opts.fineProceedsActorId,
      });
    }
  });

  return [onRegister, onPatrol, onBust];
}

function bustStall(args: {
  world: World;
  clock: import("../core/clock.js").Clock;
  stall: MarketStall;
  fine: number;
  marketLocationId: number;
  officerActorId: number;
  fineProceedsActorId: number;
}): void {
  const seller = getActorById(args.world.db, args.stall.sellerActorId);
  if (!seller) return;
  // Confiscate displayed stock — any of the seller's lots whose
  // location is the market.
  const allLots = getStockLotsByOwner(args.world.db, args.stall.sellerActorId);
  let unitsLost = 0;
  for (const lot of allLots) {
    if (lot.locationId !== args.marketLocationId) continue;
    unitsLost += lot.quantity;
    decrementLotQuantity(args.world.db, lot.id, lot.quantity);
  }
  // Charge the fine. Cap at the seller's available cash so they
  // don't go negative; the cash-conservation invariant routes the
  // collected amount to the proceeds sink.
  const finePaid = Math.min(seller.cash, args.fine);
  if (finePaid > 0) {
    adjustActorCash(args.world.db, args.stall.sellerActorId, -finePaid);
    adjustActorCash(args.world.db, args.fineProceedsActorId, finePaid);
  }
  resolveStall(args.world.db, {
    stallId: args.stall.id,
    mode: "busted",
    hour: args.clock.hour,
    finePaid,
    unitsLost,
  });
  args.world.events.emit({
    type: "market.stall-busted",
    at: args.clock,
    stallId: args.stall.id,
    sellerActorId: args.stall.sellerActorId,
    locationId: args.marketLocationId,
    officerActorId: args.officerActorId,
    finePaid,
    unitsLost,
  });
}
