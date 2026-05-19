import type { DB } from "../core/db.js";
import {
  adjustActorCash,
  getActorById,
} from "../actors/actors-repo.js";
import { getItemKindById } from "../stock/items-repo.js";
import type { KnowledgeProfile } from "../knowledge/types.js";
import type { FlawType } from "../stock/types.js";
import type { KnownFlaw } from "./inspection-repo.js";
import { recordKnownFlaw } from "./inspection-repo.js";

/**
 * "Take the engines to Boycie." A buyer pays an expert to inspect an
 * item kind. If the expert is skilled enough to spot the flaw type the
 * item actually carries, the buyer learns it (and applies the standard
 * discount on every future bid for the same kind). If the expert isn't
 * skilled, or the item is clean, the buyer just learns "looks fine to
 * me" — they wasted the fee.
 *
 * Skill threshold is `expertFlawDetection >= revealThreshold` (default
 * 0.7) — i.e. the expert needs reasonable confidence to declare a flaw.
 * Below that, they shrug.
 *
 * Cash always transfers from buyer to expert, regardless of outcome
 * (you pay for the appointment, not the answer).
 */
export interface InspectItemArgs {
  readonly buyerActorId: number;
  readonly expertActorId: number;
  readonly expertProfile: KnowledgeProfile;
  readonly itemKindId: number;
  readonly atDay: number;
  readonly fee: number;
  readonly revealThreshold?: number;
}

export type InspectItemResult =
  | {
      readonly type: "flaw-revealed";
      readonly known: KnownFlaw;
    }
  | {
      readonly type: "looks-clean";
      readonly itemHasFlaw: boolean;
    }
  | {
      readonly type: "blocked";
      readonly reason: string;
    };

export class InspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InspectionError";
  }
}

export function inspectItem(
  db: DB,
  args: InspectItemArgs,
): InspectItemResult {
  if (args.fee < 0) throw new InspectionError(`fee must be >= 0; got ${args.fee}`);
  if (args.buyerActorId === args.expertActorId) {
    return {
      type: "blocked",
      reason: "cannot inspect with yourself",
    };
  }

  return db.transaction((): InspectItemResult => {
    const buyer = getActorById(db, args.buyerActorId);
    if (!buyer) throw new InspectionError(`buyer ${args.buyerActorId} not found`);
    if (buyer.cash < args.fee) {
      return {
        type: "blocked",
        reason: `buyer cash £${buyer.cash} < fee £${args.fee}`,
      };
    }
    const expert = getActorById(db, args.expertActorId);
    if (!expert) throw new InspectionError(`expert ${args.expertActorId} not found`);
    const item = getItemKindById(db, args.itemKindId);
    if (!item) throw new InspectionError(`item kind ${args.itemKindId} not found`);

    // Charge the fee whether or not a flaw is revealed.
    if (args.fee > 0) {
      adjustActorCash(db, args.buyerActorId, -args.fee);
      adjustActorCash(db, args.expertActorId, args.fee);
    }

    if (item.flawType === null) {
      return { type: "looks-clean", itemHasFlaw: false };
    }

    const detection = expertDetectionFor(args.expertProfile, item.flawType);
    const threshold = args.revealThreshold ?? 0.7;

    if (detection < threshold) {
      // Expert isn't competent enough to spot it.
      return { type: "looks-clean", itemHasFlaw: true };
    }

    const known = recordKnownFlaw(db, {
      holderActorId: args.buyerActorId,
      itemKindId: args.itemKindId,
      flawType: item.flawType,
      learnedDay: args.atDay,
      learnedFromActorId: args.expertActorId,
    });
    return { type: "flaw-revealed", known };
  });
}

function expertDetectionFor(
  profile: KnowledgeProfile,
  flawType: FlawType,
): number {
  return (
    profile.flawDetection.get(flawType) ?? profile.defaultFlawDetection
  );
}
