import type { DB } from "./db.js";
import type { Clock, MutableClock } from "./clock.js";
import {
  advanceOneHour,
  cloneClock,
  freezeClock,
  makeClock,
} from "./clock.js";
import type { EventLog } from "./events.js";
import { createEventLog } from "./events.js";
import type { SeededRNG } from "./rng.js";

export type DayHandler = (day: number, world: World) => void;
export type HourHandler = (clock: Clock, world: World) => void;
export type Unsubscribe = () => void;

export interface WorldOptions {
  readonly db: DB;
  readonly rng: SeededRNG;
  readonly seed: string;
  readonly maxDays: number;
  readonly startDay?: number;
  readonly startHour?: number;
  readonly events?: EventLog;
}

const DEFAULT_START_DAY = 1;
const DEFAULT_START_HOUR = 0;

/**
 * The World owns the clock, the DB connection, the RNG, and the event log.
 * It runs the per-hour tick loop and dispatches lifecycle hooks
 * (`onDayStart`, `onDayEnd`, `onHour`) that mechanics register against.
 *
 * The World is intentionally minimal in M1 — hooks exist but no engine
 * subsystem registers against them yet. Subsequent milestones add stock,
 * deals, leads, pools, auctions etc. as hook listeners.
 */
export class World {
  readonly db: DB;
  readonly rng: SeededRNG;
  readonly events: EventLog;
  readonly seed: string;
  readonly maxDays: number;

  private _clock: MutableClock;
  private _started = false;
  private _ended = false;
  private _paused = false;

  private dayStartHandlers: DayHandler[] = [];
  private dayEndHandlers: DayHandler[] = [];
  private hourHandlers: HourHandler[] = [];

  constructor(opts: WorldOptions) {
    if (!Number.isInteger(opts.maxDays) || opts.maxDays < 1) {
      throw new Error(`maxDays must be a positive integer; got ${opts.maxDays}`);
    }
    this.db = opts.db;
    this.rng = opts.rng;
    this.seed = opts.seed;
    this.maxDays = opts.maxDays;
    this.events = opts.events ?? createEventLog();

    const startDay = opts.startDay ?? DEFAULT_START_DAY;
    const startHour = opts.startHour ?? DEFAULT_START_HOUR;
    this._clock = cloneClock(makeClock(startDay, startHour));
  }

  get clock(): Clock {
    return freezeClock(this._clock);
  }

  isStarted(): boolean {
    return this._started;
  }
  isFinished(): boolean {
    return this._ended;
  }
  isPaused(): boolean {
    return this._paused;
  }

  pause(): void {
    this._paused = true;
  }
  resume(): void {
    this._paused = false;
  }

  onDayStart(h: DayHandler): Unsubscribe {
    this.dayStartHandlers.push(h);
    return () => {
      this.dayStartHandlers = this.dayStartHandlers.filter((x) => x !== h);
    };
  }

  onDayEnd(h: DayHandler): Unsubscribe {
    this.dayEndHandlers.push(h);
    return () => {
      this.dayEndHandlers = this.dayEndHandlers.filter((x) => x !== h);
    };
  }

  onHour(h: HourHandler): Unsubscribe {
    this.hourHandlers.push(h);
    return () => {
      this.hourHandlers = this.hourHandlers.filter((x) => x !== h);
    };
  }

  /**
   * Boot the world. Emits `world.started` and the initial `day.started`.
   * Idempotent against a single instance — calling twice throws.
   */
  start(): void {
    if (this._started) throw new Error("world already started");
    this._started = true;

    this.events.emit({
      type: "world.started",
      at: this.clock,
      seed: this.seed,
      maxDays: this.maxDays,
    });
    this.fireDayStart(this._clock.day);
  }

  /**
   * Advance the world by one hour. No-op if paused or finished. Day
   * transitions fire `day.ended` for the closing day, then `day.started`
   * for the next one. The world stops once `clock.day > maxDays`; the
   * `world.ended` event fires from `runToCompletion` rather than here so
   * callers driving the tick manually can decide when to close out.
   */
  tickOnce(): void {
    if (!this._started) throw new Error("world not started");
    if (this._ended || this._paused) return;

    // Fire hour handlers for the current hour BEFORE advancing time, so
    // they observe the hour they're acting in.
    for (const h of this.hourHandlers) h(this.clock, this);

    const result = advanceOneHour(this._clock);
    if (result.rolledOverFromDay !== null) {
      this.fireDayEnd(result.rolledOverFromDay);
      if (this._clock.day > this.maxDays) {
        this._ended = true;
        return;
      }
      this.fireDayStart(this._clock.day);
    }
  }

  /**
   * Drive the world forward until `isFinished()` is true. Pause is checked
   * each iteration; if paused, the loop exits early and the caller can
   * resume by calling again.
   */
  runToCompletion(): void {
    if (!this._started) this.start();
    while (!this._ended) {
      if (this._paused) return;
      this.tickOnce();
    }
    this.events.emit({ type: "world.ended", at: this.clock });
  }

  private fireDayStart(day: number): void {
    this.events.emit({ type: "day.started", at: this.clock, day });
    for (const h of this.dayStartHandlers) h(day, this);
  }

  private fireDayEnd(day: number): void {
    // Day-end hooks see the clock at hour 0 of the new day; the `day`
    // argument tells them which day just closed.
    this.events.emit({ type: "day.ended", at: this.clock, day });
    for (const h of this.dayEndHandlers) h(day, this);
  }
}
