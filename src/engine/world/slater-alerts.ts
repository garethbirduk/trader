import type { World, Unsubscribe } from "../core/world.js";
import { getItemKindById } from "../stock/items-repo.js";
import type { DiaryAlertRegistry } from "./diary-alerts.js";

/**
 * Event-driven diary alerts for Slater. Listens for things he'd
 * plausibly hear about — stolen-goods changing hands at a pub, big
 * heat spikes, witnessed bribes (about other officers, hypothetically)
 * — and writes a diary alert that beelines him to the venue for a
 * few hours.
 *
 * v1 implements one trigger: a `pubdeal.agreed` whose deal carries
 * a stolen-flagged item kind. The deal's `dealId` is read via the
 * agreed event, the lines are loaded from the snapshot, and if any
 * line's item kind has `flawType === 'stolen'`, an alert is set
 * for the venue + window. This produces the cinematic beat: Del
 * sells Boyce some stolen radios at the Nag's; an anonymous tip
 * later, Slater arrives at the Nag's looking for the seller.
 *
 * Other triggers (witness leads, heat thresholds, gossip) can be
 * added by extending the event subscriber. Each trigger writes
 * its own alert with its own reason tag.
 */

export interface SlaterAlertsOptions {
  readonly slaterActorId: number;
  readonly registry: DiaryAlertRegistry;
  /** Hours the alert spans, starting at the trigger event's hour.
   *  Default 2 — Slater arrives within an hour of the tip and
   *  hangs around for the second. */
  readonly windowHours?: number;
  /** Optional delay before the alert begins, in hours. Default 1 —
   *  it takes Slater an hour to act on a tip. Set to 0 for instant
   *  response (useful in tests). */
  readonly responseLagHours?: number;
}

export function registerSlaterAlerts(
  world: World,
  opts: SlaterAlertsOptions,
): Unsubscribe {
  const windowHours = opts.windowHours ?? 2;
  const responseLag = opts.responseLagHours ?? 1;

  return world.events.subscribe((e) => {
    if (e.type !== "pubdeal.agreed") return;
    // Read the agreed deal lines from the current snapshot. The
    // pubdeal.agreed event carries dealId; the deal's lines tell us
    // which item kinds were exchanged.
    //
    // We can't easily access the snapshot from here (the subscription
    // fires during world tick). Instead, peek at the deal from the
    // db directly. The deals repo's getDealById is the entry point.
    //
    // Avoiding a hard import dep on deals-repo here — instead we look
    // up the items on the deal via raw SQL through the world db.
    const rows = world.db
      .prepare<{ item_kind_id: number }>(
        `SELECT item_kind_id FROM deal_lines WHERE deal_id = @id`,
      )
      .all({ id: e.dealId });
    let stolenInvolved = false;
    for (const r of rows) {
      const item = getItemKindById(world.db, r.item_kind_id);
      if (item?.flawType === "stolen") {
        stolenInvolved = true;
        break;
      }
    }
    if (!stolenInvolved) return;

    const fromHour = e.at.hour + responseLag;
    let fromDay = e.at.day;
    let normalisedFromHour = fromHour;
    let toDay = fromDay;
    let toHour = fromHour + windowHours - 1;
    // Roll into the next day if the window wraps past midnight.
    if (normalisedFromHour > 23) {
      fromDay += 1;
      normalisedFromHour = normalisedFromHour - 24;
      toDay = fromDay;
      toHour = normalisedFromHour + windowHours - 1;
    }
    if (toHour > 23) {
      toDay += 1;
      toHour = toHour - 24;
    }
    opts.registry.setAlert({
      actorId: opts.slaterActorId,
      destinationLocationId: e.locationId,
      fromDay,
      fromHour: normalisedFromHour,
      toDay,
      toHour,
      reason: "stolen-goods-tip",
    });
    world.events.emit({
      type: "slater.alert",
      at: e.at,
      slaterActorId: opts.slaterActorId,
      destinationLocationId: e.locationId,
      fromDay,
      fromHour: normalisedFromHour,
      toDay,
      toHour,
      reason: "stolen-goods-tip",
      sourceDealId: e.dealId,
    });
  });
}
