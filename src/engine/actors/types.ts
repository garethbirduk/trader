/**
 * Transport tiers an actor can use to deliver stock. Each tier caps the
 * units that can move in a single delivery — a coat pocket holds a
 * fistful of jewellery; a lorry holds a job lot of white goods; an
 * actor with no transport can't deliver bulk at all (skin profiles set
 * each character's tier).
 */
export const TRANSPORT_CAPACITIES = [
  "none",
  "pocket",
  "boot",
  "van",
  "truck",
] as const;
export type TransportCapacity = (typeof TRANSPORT_CAPACITIES)[number];

export function isTransportCapacity(value: unknown): value is TransportCapacity {
  return (
    typeof value === "string" &&
    (TRANSPORT_CAPACITIES as readonly string[]).includes(value)
  );
}

/** Per-tier max units that can move in a single delivery. */
export const TRANSPORT_LIMITS: Readonly<Record<TransportCapacity, number>> = {
  none: 0,
  pocket: 5,
  boot: 30,
  van: 200,
  truck: 1000,
};

/**
 * How many days it takes to get a delivery from where the stock is to
 * the delivery location. Pocket / boot are same-day (a quick drive);
 * a van takes overnight; a lorry takes a multi-day haul.
 *
 * The settlement walk uses this as a *lead-time* gate: a seller can
 * only fall back to remote stock at settlement if at least
 * `TRANSIT_DAYS_BY_TIER[tier]` days have passed since the deal was
 * agreed. Otherwise their tier physically can't have made the trip.
 */
export const TRANSIT_DAYS_BY_TIER: Readonly<Record<TransportCapacity, number>> = {
  none: 0,
  pocket: 0,
  boot: 0,
  van: 1,
  truck: 2,
};

/**
 * Minimal actor record. The base columns are id, code, displayName, cash,
 * current location, and transport tier. Behavioural fields (preferences,
 * trust map, mood, leads) arrive in later milestones as separate tables
 * keyed by actor id, not as columns here.
 */
export interface Actor {
  readonly id: number;
  readonly code: string;
  readonly displayName: string;
  readonly cash: number;
  readonly currentLocationId: number | null;
  readonly homeLocationId: number | null;
  /**
   * Where this actor stores stock by default. Distinct from home —
   * Boycie sleeps at home but his stock lives at Boyce Autos. Mike's
   * Nag's Head is both. Some actors (Trigger, Paddy) rent containers
   * at "The Lock-up". Null = no fixed lockup (uses the deal's
   * deliveryLocationId or the home).
   */
  readonly lockupLocationId: number | null;
  readonly transportCapacity: TransportCapacity;
  /**
   * Named external producer / consumer — Trader Bob, Wholesaler
   * Cyril. Virtual actors don't tick: no routine, no policy, no
   * location, no pubdeal autonomy. They exist as records so the
   * gossip layer can name them (`counterpartyActorId` on leads) and
   * they can own pools (`world_pools.owner_actor_id`). Access to a
   * virtual actor is mediated through brokers — see
   * `pool_reachability` and the placeholder skin's producer profiles.
   */
  readonly isVirtual: boolean;
  /**
   * Whether this actor accepts bribes. The wider plod (default false)
   * plays it straight. Slater specifically (true) waives a bust when
   * the bribe clears his threshold. See `world/bribe.ts`.
   */
  readonly bribable: boolean;
}
