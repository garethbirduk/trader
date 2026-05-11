import type { World, Unsubscribe } from "../core/world.js";
import { adjustActorCash } from "../actors/actors-repo.js";
import {
  deletePendingPayout,
  listDuePayouts,
} from "../payouts/pending-payouts-repo.js";

/**
 * Day-start drain of the pending_payouts table.
 *
 * Stage 7 introduces a lag on off-map resale revenue: when a whale's
 * stock liquidates at the end of day D, the cash arrives in this
 * table with `available_day = D + payoutLagDays`. This handler runs
 * at the start of each day and credits any rows whose day has come.
 *
 * The table is general-purpose — any future lagged cash flow (fines
 * with a payment-plan, escrowed deal proceeds, late market remittance)
 * can plug in here. Each payout is identified by a `source` label so
 * the viewer / trace can distinguish them.
 */
export function registerPendingPayouts(world: World): Unsubscribe {
  return world.onDayStart((day) => {
    const due = listDuePayouts(world.db, day);
    for (const payout of due) {
      adjustActorCash(world.db, payout.actorId, payout.amount);
      deletePendingPayout(world.db, payout.id);
      world.events.emit({
        type: "payout.released",
        at: world.clock,
        actorId: payout.actorId,
        amount: payout.amount,
        source: payout.source,
        originatedDay: payout.createdDay,
      });
    }
  });
}
