import type { World, Unsubscribe } from "../core/world.js";
import type { GossipExchange } from "../core/events.js";
import { getActorsAtLocation, getLocationProprietor } from "../locations/locations.js";
import {
  clarifyLead,
  getLeadsByHolder,
  shareLead,
  type ShareLeadMutator,
} from "../leads/leads-repo.js";
import { selectNovelLeads, toExchange } from "../leads/gossip-utils.js";
import { mutateLead } from "../leads/mutation.js";
import {
  DEFAULT_ECONOMICS_CONFIG,
  type EconomicsConfig,
} from "../economics/config.js";
import type { Lead } from "../leads/types.js";

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
  /** Probability per chat that each side rolls a clarification — picks
   *  one of their warmest held leads and asks the other party what
   *  *they* know about that exact subject. Independent of the novel-lead
   *  swap; produces a separate `kind: "clarification"` event when fruit
   *  comes back. Default 0.4 — clarifications are common but not every
   *  exchange. */
  readonly clarificationChance?: number;
  /** Economic config — supplies `gossipMutation` knobs to the per-hop
   *  mutator. Defaults to the engine defaults when unset. */
  readonly economics?: EconomicsConfig;
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
  const clarificationChance = opts.clarificationChance ?? 0.4;
  const mutationConfig = (opts.economics ?? DEFAULT_ECONOMICS_CONFIG).gossipMutation;
  const mutate: ShareLeadMutator = (input) =>
    mutateLead(input, world.rng, mutationConfig);

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
          mutate,
        });

        if (exchanges.length > 0) {
          world.events.emit({
            type: "gossip.exchanged",
            at: clock,
            atLocationId: locId,
            kind: "chat",
            participantActorIds: [a, b],
            exchanges,
          });
        }

        // After the casual exchange, each side may turn the conversation
        // to a *specific* subject they hold — "what's your version of
        // this Casios story?" Clarifications produce a separate event so
        // the diary can show the difference between drifted chatter and
        // a deliberate cross-check.
        const clarifications = runClarifications({
          world,
          a,
          b,
          clarificationChance,
          onDay: clock.day,
          mutate,
        });
        if (clarifications.length > 0) {
          world.events.emit({
            type: "gossip.exchanged",
            at: clock,
            atLocationId: locId,
            kind: "clarification",
            participantActorIds: [a, b],
            exchanges: clarifications,
          });
        }
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
  mutate: ShareLeadMutator;
}): GossipExchange[] {
  const { world, dayHour, a, b, maxPerSide, mutate } = args;

  const aLeads = getLeadsByHolder(world.db, a);
  const bLeads = getLeadsByHolder(world.db, b);

  const exchanges: GossipExchange[] = [];
  pourLeads(world, a, b, aLeads, bLeads, maxPerSide, dayHour.day, mutate, exchanges);
  pourLeads(world, b, a, bLeads, aLeads, maxPerSide, dayHour.day, mutate, exchanges);
  return exchanges;
}

/**
 * Roll clarifications each direction between `a` and `b`. The asker
 * picks one of their own currently-held leads — preferring warm ones
 * and breaking ties by recency (highest id) — and asks the partner
 * what *they* know about the same subject. If the partner has a
 * matching lead, it's pulled (with mutation) into the asker's bag.
 *
 * Pure side-effect aside from DB writes; returns the GossipExchange
 * list for the event payload. The asker's existing lead on the
 * subject persists, so divergent versions sit side-by-side and the
 * ledger view can highlight the conflict.
 */
function runClarifications(args: {
  world: World;
  a: number;
  b: number;
  clarificationChance: number;
  onDay: number;
  mutate: ShareLeadMutator;
}): GossipExchange[] {
  const { world, a, b, clarificationChance, onDay, mutate } = args;
  const out: GossipExchange[] = [];
  if (clarificationChance <= 0) return out;

  for (const [askerId, targetId] of [
    [a, b],
    [b, a],
  ] as const) {
    if (!world.rng.chance(clarificationChance)) continue;
    const heldLeads = getLeadsByHolder(world.db, askerId);
    const candidate = pickClarificationSubject(heldLeads, world);
    if (candidate === null) continue;
    try {
      const received = clarifyLead(
        world.db,
        askerId,
        targetId,
        {
          side: candidate.side,
          subjectItemKindId: candidate.subjectItemKindId,
          subjectQualityTier: candidate.subjectQualityTier,
          counterpartyActorId: candidate.counterpartyActorId,
        },
        onDay,
        { mutate },
      );
      if (received !== null) {
        out.push(toExchange(received, targetId, askerId));
      }
    } catch {
      // Self-share or constraint failure — skip silently.
    }
  }
  return out;
}

/** Warm-first, then most recently acquired. Null if the asker has nothing. */
function pickClarificationSubject(
  leads: readonly Lead[],
  world: World,
): Lead | null {
  if (leads.length === 0) return null;
  const warm = leads.filter((l) => l.confidence === "warm");
  const pool = warm.length > 0 ? warm : leads;
  // Lightweight "freshest of the warm bag" — sort by id descending and
  // RNG-pick from the top quarter so behaviour is stochastic without
  // being uniform.
  const sorted = [...pool].sort((x, y) => y.id - x.id);
  const topN = Math.max(1, Math.ceil(sorted.length / 4));
  return world.rng.pick(sorted.slice(0, topN));
}

function pourLeads(
  world: World,
  fromActorId: number,
  toActorId: number,
  fromLeads: readonly import("../leads/types.js").Lead[],
  toLeadsSnapshot: readonly import("../leads/types.js").Lead[],
  cap: number,
  onDay: number,
  mutate: ShareLeadMutator,
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
      const received = shareLead(
        world.db, fromActorId, toActorId, lead.id, onDay,
        { mutate },
      );
      out.push(toExchange(received, fromActorId, toActorId));
    } catch {
      // Holder mismatch (lead already moved) or self-share — skip silently.
    }
  }
}
