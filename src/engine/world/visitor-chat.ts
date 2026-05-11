import type { World, Unsubscribe } from "../core/world.js";
import type { GossipExchange } from "../core/events.js";
import { getActorsAtLocation, getLocationProprietor } from "../locations/locations.js";
import { getLeadsByHolder, shareLead } from "../leads/leads-repo.js";
import { selectNovelLeads, toExchange } from "../leads/gossip-utils.js";

export interface VisitorChatOptions {
  /** Venues where chat fires — typically pubs and other "lingering" spaces.
   *  Each hour, pair-trials are run independently per location. */
  readonly chatLocationIds: readonly number[];
  /** Actors eligible to initiate / accept a chat. The wider cast may be
   *  present (Cassandra ordering a half at the Nag's) but doesn't enter
   *  the gossip mix unless they're in this set. Defaults to "anyone in
   *  the venue who isn't the proprietor." */
  readonly eligibleActorIds?: ReadonlySet<number>;
  /** Per-actor yield boost: when either side of a chat pair is in this
   *  set, the conversation yields `infoTraderChatYield` leads each way
   *  instead of `chatLeadsPerExchange`. Models Denzil-on-his-rounds,
   *  Sid-behind-the-counter, Mike-with-the-regulars: outsized rumour
   *  capacity per encounter. */
  readonly infoTraderActorIds?: ReadonlySet<number>;
  /** Hour window in which chats can fire. Default 11–22 — the social
   *  envelope covers daytime cafes through last-orders pubs. */
  readonly startHour?: number;
  readonly endHour?: number;
  /** How many pair trials each chat-location runs per hour. */
  readonly attemptsPerHour?: number;
  /** Probability each trial actually pairs up (otherwise just silence). */
  readonly pairChance?: number;
  /** Novel leads exchanged each direction per chat in the baseline case. */
  readonly chatLeadsPerExchange?: number;
  /** Novel leads each direction when at least one party is an info-trader. */
  readonly infoTraderChatYield?: number;
}

/**
 * Visitor↔visitor chat at social venues.
 *
 * Mechanically a peer to `location-gossip.ts` (proprietor drive-by) and
 * the deal-side gossip in `pub-deal-gossip.ts`: same novelty filter,
 * same `gossip.exchanged` event, same source-chain semantics. What's
 * different is the venue scope (only the venues where lingering is
 * normal) and that the proprietor is explicitly excluded — they get
 * their own drive-by on each visitor's arrival, so layering chat on
 * top would double-count their bandwidth.
 *
 * Each hour, every chat venue runs `attemptsPerHour` independent pair
 * trials. A trial picks two eligible actors at that venue at random;
 * with probability `pairChance` they have a conversation, exchanging
 * up to N novel leads each way. N defaults to `chatLeadsPerExchange`
 * but jumps to `infoTraderChatYield` whenever either party is flagged
 * as an information trader — Mike, Sid, Denzil, Albert. Those four
 * are the cinematic gossip carriers; the same chair at the bar, the
 * same caff every morning, more rumours per round.
 *
 * The same pair may be drawn twice in one hour — that's a feature
 * (a longer chat over multiple rounds), not a bug, and falls naturally
 * out of the novelty filter (the second draw shares whatever wasn't
 * said the first time, or nothing if the well's dry).
 */
export function registerVisitorChat(
  world: World,
  opts: VisitorChatOptions,
): Unsubscribe {
  const startHour = opts.startHour ?? 11;
  const endHour = opts.endHour ?? 22;
  const attemptsPerHour = opts.attemptsPerHour ?? 2;
  const pairChance = opts.pairChance ?? 0.5;
  const baseYield = opts.chatLeadsPerExchange ?? 2;
  const infoYield = opts.infoTraderChatYield ?? 4;
  const eligible = opts.eligibleActorIds ?? null;
  const infoTraders = opts.infoTraderActorIds ?? new Set<number>();

  return world.onHour((clock) => {
    if (clock.hour < startHour || clock.hour > endHour) return;

    for (const locId of opts.chatLocationIds) {
      const proprietorId = getLocationProprietor(world.db, locId);
      const presentAll = getActorsAtLocation(world.db, locId);
      const present = presentAll.filter(
        (id) =>
          id !== proprietorId &&
          (eligible === null || eligible.has(id)),
      );
      if (present.length < 2) continue;

      for (let trial = 0; trial < attemptsPerHour; trial += 1) {
        if (!world.rng.chance(pairChance)) continue;

        const a = world.rng.pick(present);
        const others = present.filter((id) => id !== a);
        if (others.length === 0) continue;
        const b = world.rng.pick(others);

        const yieldPerSide =
          infoTraders.has(a) || infoTraders.has(b) ? infoYield : baseYield;

        const exchanges = swapNovelLeads({
          world,
          locId,
          dayHour: clock,
          a,
          b,
          maxPerSide: yieldPerSide,
        });

        if (exchanges.length === 0) continue;
        world.events.emit({
          type: "gossip.exchanged",
          at: clock,
          atLocationId: locId,
          kind: "chat",
          participantActorIds: [a, b],
          exchanges,
        });
      }
    }
  });
}

/**
 * Exchange up to `maxPerSide` novel leads each direction between `a`
 * and `b`. Returns the `GossipExchange` list — empty if nothing novel
 * either way. The DB writes are interleaved so leads transferred in
 * one direction don't accidentally count as "already known" when the
 * reverse direction is computed (we snapshot both bags up front).
 */
function swapNovelLeads(args: {
  world: World;
  locId: number;
  dayHour: { day: number; hour: number };
  a: number;
  b: number;
  maxPerSide: number;
}): GossipExchange[] {
  const { world, dayHour, a, b, maxPerSide } = args;

  const aLeads = getLeadsByHolder(world.db, a);
  const bLeads = getLeadsByHolder(world.db, b);

  const exchanges: GossipExchange[] = [];
  pourLeads(world, a, b, aLeads, bLeads, maxPerSide, dayHour.day, exchanges);
  pourLeads(world, b, a, bLeads, aLeads, maxPerSide, dayHour.day, exchanges);
  return exchanges;
}

function pourLeads(
  world: World,
  fromActorId: number,
  toActorId: number,
  fromLeads: readonly import("../leads/types.js").Lead[],
  toLeadsSnapshot: readonly import("../leads/types.js").Lead[],
  cap: number,
  onDay: number,
  out: GossipExchange[],
): void {
  if (cap <= 0) return;
  const novel = selectNovelLeads(fromLeads, toLeadsSnapshot);
  if (novel.length === 0) return;

  // Sample without replacement: shuffle, take the first `cap`. Keeping
  // selectNovelLeads' warm-first order means the warm ones are drawn
  // preferentially within the shuffle.
  const pool = [...novel];
  let drawn = 0;
  while (drawn < cap && pool.length > 0) {
    const idx = Math.floor(world.rng.next() * pool.length);
    const lead = pool[idx]!;
    pool.splice(idx, 1);
    drawn += 1;
    try {
      shareLead(world.db, fromActorId, toActorId, lead.id, onDay);
      out.push(toExchange(lead, fromActorId, toActorId));
    } catch {
      // Holder mismatch (lead already moved) or self-share — skip silently.
    }
  }
}
