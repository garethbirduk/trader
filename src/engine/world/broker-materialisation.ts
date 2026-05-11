import type { World, Unsubscribe } from "../core/world.js";
import {
  adjustActorCash,
  getActorById,
} from "../actors/actors-repo.js";
import {
  getActorsAtLocation,
  setActorLocation,
} from "../locations/locations.js";
import { listActivePoolsByOwner } from "../pools/pools-repo.js";
import { getRepLeadAbout } from "../leads/leads-repo.js";

export interface BrokerMaterialisationOptions {
  /** Venues where a broker can bring their producer in for a face-
   *  to-face. Typically pubs — that's the cinematic location. */
  readonly venueLocationIds: readonly number[];
  /** Per-(broker, hour) probability of attempting a materialisation,
   *  conditional on the broker being at one of the venues and having
   *  a producer with live owned stock. Default 0.05 — uncommon but
   *  visible across a 14-day run. */
  readonly attemptChancePerHour?: number;
  /** Hours during which a broker can initiate. Inclusive. Defaults to
   *  the pub envelope (18–22) when unset. */
  readonly startHour?: number;
  readonly endHour?: number;
  /** Cash transferred from broker to the proceeds account as the
   *  broker fee. Default £25. */
  readonly fee?: number;
  /** Where the broker fee lands (typically the auction-house actor,
   *  which doubles as the off-map ledger). Null = burned. */
  readonly feeProceedsActorId?: number | null;
  /**
   * Skin-supplied mapping of broker actor id → producers they have a
   * relationship with. Built from `SkinSeedResult.virtualProducers`
   * (each producer's brokerActorIds list inverted into per-broker
   * arrays). A broker can only materialise producers in their map
   * entry.
   */
  readonly producersByBroker: ReadonlyMap<number, readonly number[]>;
  /**
   * Threshold for the rep-gate. A warm rep lead at or above this
   * `estimatedUnitPrice` (= £-damage), and at or below `repAbortMaxHops`
   * hop count, blocks the materialisation. Defaults align with the
   * pub-deal autonomy rep-gate so the two systems compose.
   */
  readonly repAbortDamageThreshold?: number;
  readonly repAbortMaxHops?: number;
}

/**
 * Stage 6b — broker materialisation.
 *
 * Each hour, for every broker present at a configured venue, we may
 * fire a materialisation attempt: the broker pays a fee, and one of
 * their virtual producers gets a temporary `current_location_id` set
 * to the venue. While materialised, every actor at the venue gains
 * implicit reachability to the producer's live owned pools (the
 * `isReachableBy` extension handles this), so the existing pool-claim
 * autonomy organically picks up the new access.
 *
 * Before the producer "walks in" we consult the rep ledger in both
 * directions:
 *
 *   • producer-knows-blocker — the producer holds warm rep about
 *     someone at the venue. They clock them and walk straight back out.
 *   • blocker-knows-producer — someone at the venue holds warm rep
 *     about the producer. The would-be customer decides the meeting
 *     isn't on. (In practice the broker calls it off.)
 *
 * Either case fires a `broker.materialisation-aborted` event with the
 * blocker identified. The fee is NOT charged on abort — the broker
 * never got the meeting going.
 *
 * Teardown: at the end of the materialised hour (`untilHour`), the
 * producer's `current_location_id` is cleared. Today the span is a
 * single hour; the option is there for longer windows later.
 */
export function registerBrokerMaterialisation(
  world: World,
  opts: BrokerMaterialisationOptions,
): Unsubscribe {
  const attemptChance = opts.attemptChancePerHour ?? 0.05;
  const startHour = opts.startHour ?? 18;
  const endHour = opts.endHour ?? 22;
  const fee = opts.fee ?? 25;
  const feeProceedsActorId = opts.feeProceedsActorId ?? null;
  const repAbortDamageThreshold = opts.repAbortDamageThreshold ?? 100;
  const repAbortMaxHops = opts.repAbortMaxHops ?? 2;
  // Active materialisations, keyed by producer id → the hour at which
  // their location should be torn down. We tear down at the *start* of
  // the post-window hour so the materialised period is exactly the
  // hour they appeared in.
  const teardownByProducer = new Map<number, number>();

  return world.onHour((clock) => {
    // Teardown pass: any producer whose untilHour matches the current
    // hour gets their location cleared. `tornDownThisHour` blocks any
    // attempt in the same tick from immediately re-materialising the
    // same producer — they should leave at the end of their hour.
    const tornDownThisHour = new Set<number>();
    for (const [producerId, untilHour] of teardownByProducer) {
      if (clock.hour >= untilHour) {
        setActorLocation(world.db, producerId, null);
        teardownByProducer.delete(producerId);
        tornDownThisHour.add(producerId);
      }
    }

    if (clock.hour < startHour || clock.hour > endHour) return;

    for (const venueId of opts.venueLocationIds) {
      const present = getActorsAtLocation(world.db, venueId);
      if (present.length === 0) continue;

      for (const brokerId of present) {
        const producers = opts.producersByBroker.get(brokerId);
        if (producers === undefined || producers.length === 0) continue;
        if (!world.rng.chance(attemptChance)) continue;
        const producerId = world.rng.pick(producers);
        if (teardownByProducer.has(producerId)) continue; // already in the room
        if (tornDownThisHour.has(producerId)) continue;   // just left this hour

        // Skip if the producer has no live stock — no point.
        const livePools = listActivePoolsByOwner(world.db, producerId, clock.day);
        if (livePools.length === 0) continue;

        const broker = getActorById(world.db, brokerId);
        if (!broker) continue;
        if (broker.cash < fee) continue;

        // Rep gate — symmetric. We check both directions and abort on
        // the first blocker found. Either direction is enough to scotch
        // the meeting.
        let blockerId: number | null = null;
        let blockerLeadId = -1;
        let direction: "producer-knows-blocker" | "blocker-knows-producer" =
          "producer-knows-blocker";
        // (a) does the producer hold rep about anyone present?
        for (const attendeeId of present) {
          if (attendeeId === producerId) continue;
          const lead = getRepLeadAbout(world.db, producerId, attendeeId);
          if (
            lead !== null &&
            lead.confidence === "warm" &&
            lead.hopCount <= repAbortMaxHops &&
            lead.estimatedUnitPrice >= repAbortDamageThreshold
          ) {
            blockerId = attendeeId;
            blockerLeadId = lead.id;
            direction = "producer-knows-blocker";
            break;
          }
        }
        // (b) does anyone present hold rep about the producer?
        if (blockerId === null) {
          for (const attendeeId of present) {
            const lead = getRepLeadAbout(world.db, attendeeId, producerId);
            if (
              lead !== null &&
              lead.confidence === "warm" &&
              lead.hopCount <= repAbortMaxHops &&
              lead.estimatedUnitPrice >= repAbortDamageThreshold
            ) {
              blockerId = attendeeId;
              blockerLeadId = lead.id;
              direction = "blocker-knows-producer";
              break;
            }
          }
        }

        if (blockerId !== null) {
          world.events.emit({
            type: "broker.materialisation-aborted",
            at: clock,
            brokerActorId: brokerId,
            producerActorId: producerId,
            locationId: venueId,
            blockerActorId: blockerId,
            repLeadId: blockerLeadId,
            direction,
          });
          continue;
        }

        // Materialise: charge fee, set producer's location, schedule
        // teardown.
        adjustActorCash(world.db, brokerId, -fee);
        if (feeProceedsActorId !== null) {
          adjustActorCash(world.db, feeProceedsActorId, fee);
        }
        setActorLocation(world.db, producerId, venueId);
        // untilHour = current hour + 1 → torn down at the start of
        // the next hour's pass.
        teardownByProducer.set(producerId, clock.hour + 1);

        world.events.emit({
          type: "broker.materialised",
          at: clock,
          brokerActorId: brokerId,
          producerActorId: producerId,
          locationId: venueId,
          untilHour: clock.hour + 1,
          fee,
          attendees: [...present],
        });
      }
    }
  });
}
