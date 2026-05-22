import type { World, Unsubscribe } from "../core/world.js";
import type { KnowledgeProfile } from "../knowledge/types.js";
import {
  adjustActorCash,
  getActorById,
} from "../actors/actors-repo.js";
import { getLocationProprietor } from "../locations/locations.js";
import { getItemKindById } from "../stock/items-repo.js";
import {
  getLockedLeadsByHolder,
  unlockLeadDetail,
} from "../leads/leads-repo.js";
import { recordLeadDisclosure } from "../leads/disclosures-repo.js";
import {
  DEFAULT_ECONOMICS_CONFIG,
  type EconomicsConfig,
} from "../economics/config.js";
import { resolvePerArmDials } from "../perception/expertise.js";
export interface DetailUnlockOptions {
  /** Per-actor bidder profile. Used to compute the interest bonus when
   *  rolling for an autonomous ask. Optional — missing actors fall
   *  back to base probability with no bonus. */
  readonly knowledgeProfiles: ReadonlyMap<number, KnowledgeProfile>;
  /** Actors that get the info-trader probability multiplier. The
   *  bar-stool gossips (Mike, Sid, Albert) plus anyone tagged in the
   *  skin as a chatty intel-collector. */
  readonly infoTraderActorIds?: ReadonlySet<number>;
  /** Actors eligible to be the asker. NPCs not in this set never roll
   *  for an autonomous ask. The player is excluded — their unlock is
   *  player-driven from the UI, not from the autonomy roll. */
  readonly autonomyEligibleActorIds: ReadonlySet<number>;
  /** Economics bundle — supplies `detailUnlock` knobs and the planner's
   *  `interestThreshold` for the category-interest computation. */
  readonly economics?: EconomicsConfig;
}

export interface UnlockAttemptArgs {
  readonly askerActorId: number;
  readonly partnerActorId: number;
  readonly locationId: number;
  readonly day: number;
  readonly hour: number;
}

export interface UnlockAttemptResult {
  readonly outcome: "ok" | "ineligible";
  readonly reason?: string;
  readonly unlockedLeadIds?: readonly number[];
}

/**
 * Two-tier gossip — paid detail unlock.
 *
 * Subscribes to `gossip.exchanged` of kind `chat` or `proprietor` —
 * the venues where the asker can buy a partner a drink. After a
 * successful exchange, for each side as a candidate asker:
 *
 *   • Hard eligibility:
 *       - asker is in `autonomyEligibleActorIds`
 *       - asker.cash >= `minCash`
 *       - asker holds >= 1 locked headline whose counterparty is not
 *         the asker themselves (no paying to "discover" your own
 *         stock or wishlist)
 *
 *   • Autonomy roll (skipped if asker == playerActorId; the player
 *     drives the action from the UI):
 *       prob = baseProb
 *            × infoTraderMul (if asker is info-trader)
 *            + interestBonusPerMatch × number-of-locked-headlines
 *              whose category is in asker's appraisal-interest band
 *
 *   • Effect on roll-pass:
 *       - Debit `price` from asker; pay it to the venue
 *         proprietor (or sink to off-map account if none).
 *       - Pick top-N most-recent locked headlines from asker's bag
 *         (excluding self-subject leads).
 *       - For each, flip detail_unlocked 0→1 (the lead's drifted
 *         detail fields become visible in-place) and write an audit
 *         row to `lead_disclosures`.
 *       - Emit `gossip.detail-unlocked`.
 *
 * The player's unlock action calls `attemptDetailUnlock` directly,
 * bypassing the autonomy roll (player intent is the trigger).
 */
export function registerDetailUnlock(
  world: World,
  opts: DetailUnlockOptions,
): Unsubscribe {
  const economics = opts.economics ?? DEFAULT_ECONOMICS_CONFIG;
  const cfg = economics.detailUnlock;
  if (!cfg.enabled) return () => {};

  return world.events.subscribe((e) => {
    if (e.type !== "gossip.exchanged") return;
    if (e.kind !== "chat" && e.kind !== "proprietor") return;
    if (e.participantActorIds.length < 2) return;

    const [a, b] = e.participantActorIds;
    if (a === undefined || b === undefined) return;

    // For proprietor exchanges the visitor is always index 0; the
    // proprietor is always index 1. Only the visitor can be the asker
    // (the proprietor is the source of headlines, not the buyer).
    // For chat exchanges either side can ask.
    const candidates: readonly [number, number][] =
      e.kind === "proprietor" ? [[a, b]] : [[a, b], [b, a]];

    for (const [asker, partner] of candidates) {
      if (!opts.autonomyEligibleActorIds.has(asker)) continue;
      if (!shouldRoll(world, opts, economics, asker)) continue;
      attemptDetailUnlock(world, opts, {
        askerActorId: asker,
        partnerActorId: partner,
        locationId: e.atLocationId,
        day: e.at.day,
        hour: e.at.hour,
      });
    }
  });
}

/**
 * Run the eligibility + autonomy roll for `asker`. Returns true iff
 * the asker should fire an unlock this exchange. Pure function over
 * world state — no side effects.
 */
function shouldRoll(
  world: World,
  opts: DetailUnlockOptions,
  economics: EconomicsConfig,
  asker: number,
): boolean {
  const cfg = economics.detailUnlock;
  const actor = getActorById(world.db, asker);
  if (actor === null) return false;
  if (actor.cash < cfg.minCash) return false;

  const locked = getLockedLeadsByHolder(world.db, asker).filter(
    (l) => l.counterpartyActorId !== asker,
  );
  if (locked.length === 0) return false;

  // Probability: base, optionally bumped by info-trader status,
  // then nudged by the count of headlines whose category sits in
  // the asker's interest band.
  let prob = cfg.baseProb;
  if (opts.infoTraderActorIds?.has(asker)) {
    prob *= cfg.infoTraderProbMultiplier;
  }
  const interestMatches = countInterestMatches(
    world,
    opts,
    economics,
    asker,
    locked,
  );
  prob += cfg.interestBonusPerMatch * interestMatches;

  return world.rng.chance(Math.min(1, Math.max(0, prob)));
}

function countInterestMatches(
  world: World,
  opts: DetailUnlockOptions,
  economics: EconomicsConfig,
  asker: number,
  locked: readonly { readonly subjectItemKindId: number | null }[],
): number {
  const profile = opts.knowledgeProfiles.get(asker);
  if (profile === undefined) return 0;
  // Route the per-category interest check through the judgement
  // engine's per-arm resolver rather than reading the legacy
  // `appraisalAccuracy` scalar directly. Numerically equivalent
  // today (deriveKnowledgeProfile copies appraisalAccuracy into
  // priceAccuracy), but means the test diverges automatically when
  // skins set per-arm overrides in the NPC-specialists pass.
  const knowledgeProfile = profile;
  const threshold = economics.detailUnlock.categoryInterestThreshold;
  let n = 0;
  for (const lead of locked) {
    if (lead.subjectItemKindId === null) continue;
    const item = getItemKindById(world.db, lead.subjectItemKindId);
    if (item === null) continue;
    const dials = resolvePerArmDials({
      db: world.db,
      actorId: asker,
      arm: "price",
      key: item.category,
      profileOverride: knowledgeProfile,
    });
    if (dials.expertise >= threshold) n += 1;
  }
  return n;
}

/**
 * Run an unlock session against (asker, partner) at the named venue.
 * Bypasses the autonomy roll — caller is responsible for gating. Used
 * directly by the player's UI action and indirectly by the autonomy
 * handler in `registerDetailUnlock`.
 *
 * Returns `outcome: 'ineligible'` if hard gates fail (insufficient
 * cash, no locked leads). On success, debits the price, flips up to
 * `unlockYield` locked leads, records audit rows, and emits the
 * `gossip.detail-unlocked` event.
 */
export function attemptDetailUnlock(
  world: World,
  opts: DetailUnlockOptions,
  args: UnlockAttemptArgs,
): UnlockAttemptResult {
  const economics = opts.economics ?? DEFAULT_ECONOMICS_CONFIG;
  const cfg = economics.detailUnlock;

  if (!cfg.enabled) return { outcome: "ineligible", reason: "disabled" };
  if (args.askerActorId === args.partnerActorId) {
    return { outcome: "ineligible", reason: "self-unlock" };
  }

  const asker = getActorById(world.db, args.askerActorId);
  if (asker === null) return { outcome: "ineligible", reason: "no-asker" };
  if (asker.cash < cfg.price) {
    return { outcome: "ineligible", reason: "insufficient-cash" };
  }

  // Self-subject leads (where the asker is the named counterparty) are
  // excluded — you don't pay to learn what *you* supply or want; the
  // judgement engine already gives you first-hand certainty on your own
  // stock and wishlist. Filter before the empty check so an asker whose
  // bag is *only* self-subject is treated as having nothing to unlock.
  const locked = getLockedLeadsByHolder(world.db, args.askerActorId).filter(
    (l) => l.counterpartyActorId !== args.askerActorId,
  );
  if (locked.length === 0) {
    return { outcome: "ineligible", reason: "no-locked-leads" };
  }

  const pick = locked.slice(0, cfg.unlockYield);

  // Cash flow: asker → venue proprietor (or off-map sink if none).
  const proprietorId = getLocationProprietor(world.db, args.locationId);
  adjustActorCash(world.db, args.askerActorId, -cfg.price);
  if (proprietorId !== null && proprietorId !== args.askerActorId) {
    adjustActorCash(world.db, proprietorId, cfg.price);
  }
  // If no proprietor, the cash sinks. Off-map sweep handles the
  // accounting at end-of-day.

  const unlockedLeads: { leadId: number; unlocked: boolean }[] = [];
  for (const lead of pick) {
    const flipped = unlockLeadDetail(world.db, lead.id);
    const wasFlipped = flipped !== null;
    if (wasFlipped) {
      recordLeadDisclosure(world.db, {
        leadId: lead.id,
        actorId: args.askerActorId,
        revealedAtDay: args.day,
        revealedByActorId: args.partnerActorId,
        costPaid: cfg.price,
      });
    }
    unlockedLeads.push({ leadId: lead.id, unlocked: wasFlipped });
  }

  world.events.emit({
    type: "gossip.detail-unlocked",
    at: { day: args.day, hour: args.hour },
    atLocationId: args.locationId,
    askerActorId: args.askerActorId,
    partnerActorId: args.partnerActorId,
    costPaid: cfg.price,
    paidToActorId:
      proprietorId !== null && proprietorId !== args.askerActorId
        ? proprietorId
        : null,
    unlockedLeads,
  });

  return {
    outcome: "ok",
    unlockedLeadIds: unlockedLeads.filter((u) => u.unlocked).map((u) => u.leadId),
  };
}
