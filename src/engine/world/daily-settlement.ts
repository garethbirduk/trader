import { getAgreedDealsDueBy } from "../deals/deals-repo.js";
import {
  markDealDefaulted,
  settleDeal,
} from "../deals/settlement.js";
import type { World, Unsubscribe } from "../core/world.js";

export interface DailySettlementOptions {
  /**
   * Where cash flows when the settlement walk claims from a supply lead's
   * underlying pool. Skins should set this to keep cash conserved (the
   * placeholder skin sends it to the auction-house actor).
   */
  readonly procurementProceedsActorId?: number | null;
}

/**
 * Register a day-start handler that, every morning, attempts to settle all
 * `agreed` deals whose deadline is on or before today. Successful
 * settlements transfer stock + cash; failures (short stock, insufficient
 * cash) are turned into defaults and the cascading reputation hit follows.
 *
 * This is the engine's enforcement loop — it makes deadlines bite without
 * any actor having to "decide" to settle. Defaults emerge from the
 * collision between promises and reality.
 */
export function registerDailySettlement(
  world: World,
  opts: DailySettlementOptions = {},
): Unsubscribe {
  return world.onDayStart((day) => {
    const due = getAgreedDealsDueBy(world.db, day);
    for (const deal of due) {
      try {
        // settleDeal emits `deal.settled` when given an events log;
        // daily-settlement is responsible for the default-side event.
        settleDeal(world.db, deal.id, day, {
          procurementProceedsActorId: opts.procurementProceedsActorId ?? null,
          events: world.events,
          atClock: world.clock,
        });
      } catch (e) {
        const reason = (e as Error).message;
        markDealDefaulted(world.db, deal.id, day, reason);
        world.events.emit({
          type: "deal.defaulted",
          at: world.clock,
          dealId: deal.id,
          buyerActorId: deal.buyerActorId,
          sellerActorId: deal.sellerActorId,
          reason,
        });
      }
    }
  });
}
