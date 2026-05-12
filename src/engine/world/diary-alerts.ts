import type { Clock } from "../core/clock.js";

/**
 * Event-driven diary overrides — a general mechanism for "something
 * happened, this actor should drop what they were doing and go here
 * for the next N hours."
 *
 * Slater is the first user (todolist: patrol mode + tip-offs). A
 * pubdeal involving stolen goods plants an alert that beelines
 * Slater to the pub for the next two hours, regardless of his
 * scheduled patrol pick.
 *
 * The registry is read by the policy's `hourOverride` callback,
 * before the patrol/lunch/planner fallbacks. Alerts have a
 * (fromDay, fromHour) and (toDay, toHour) clock window; the get
 * call returns the most-recent active alert for that actor.
 */

export interface DiaryAlert {
  readonly actorId: number;
  readonly destinationLocationId: number;
  readonly fromDay: number;
  readonly fromHour: number;
  readonly toDay: number;
  readonly toHour: number;
  /** Tag for the UI / event trace — "stolen-goods-tip", "bribe-overheard", … */
  readonly reason: string;
}

export class DiaryAlertRegistry {
  private alerts: DiaryAlert[] = [];

  setAlert(alert: DiaryAlert): void {
    if (alert.toDay < alert.fromDay) {
      throw new Error("alert.toDay must be >= alert.fromDay");
    }
    if (alert.toDay === alert.fromDay && alert.toHour < alert.fromHour) {
      throw new Error("alert window must end on/after it starts");
    }
    this.alerts.push(alert);
  }

  /**
   * Return the most-recent alert active for `actorId` at `clock`. If
   * multiple alerts overlap, the latest-added wins — the freshest
   * tip-off takes priority.
   */
  getAlertAt(actorId: number, clock: Clock): DiaryAlert | null {
    for (let i = this.alerts.length - 1; i >= 0; i -= 1) {
      const a = this.alerts[i]!;
      if (a.actorId !== actorId) continue;
      if (clockBefore(clock, { day: a.fromDay, hour: a.fromHour })) continue;
      if (clockAfter(clock, { day: a.toDay, hour: a.toHour })) continue;
      return a;
    }
    return null;
  }

  /** Drop alerts whose window has fully ended before `clock`. */
  pruneExpired(clock: Clock): void {
    this.alerts = this.alerts.filter(
      (a) => !clockAfter(clock, { day: a.toDay, hour: a.toHour }),
    );
  }

  /** Test seam — returns a snapshot of currently-registered alerts. */
  snapshot(): readonly DiaryAlert[] {
    return [...this.alerts];
  }
}

function clockBefore(a: Clock, b: Clock): boolean {
  if (a.day < b.day) return true;
  if (a.day > b.day) return false;
  return a.hour < b.hour;
}

function clockAfter(a: Clock, b: Clock): boolean {
  if (a.day > b.day) return true;
  if (a.day < b.day) return false;
  return a.hour > b.hour;
}
