/**
 * Live mode: run the engine in the browser via sql.js (WASM SQLite).
 * Selected by `?mode=live` in the URL. The default behavior (fetching
 * a pre-baked `events.json`) is unchanged.
 *
 * The engine, setupWorld, snapshot capture, and RunDump building are
 * all reused from the Node sim. Only the DB driver and the WASM file
 * loading differ.
 */

import initSqlJs from "sql.js";
// Vite resolves this to a URL string at build/dev time; the WASM file
// is served as a static asset rather than bundled into the JS chunk.
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";

import { openSqlJsDB } from "../../src/engine/core/db-sqljs.js";
import { setupWorld } from "../../src/engine/setup.js";
import {
  buildRunDump,
  captureSnapshot,
  newTally,
  updateTally,
  type DaySnapshot,
  type RunDump as EngineRunDump,
} from "../../src/engine/snapshot.js";
import type { WorldEvent } from "../../src/engine/core/events.js";
import type { RunDump as ViewerRunDump } from "./types.js";

export interface LiveRunOptions {
  readonly seed: string;
  readonly days: number;
  readonly onProgress?: (status: string) => void;
}

/**
 * Boot sql.js, run the engine for `days` days against seed `seed`, and
 * return a RunDump matching what the static `events.json` path would
 * have produced. The returned object is structurally compatible with
 * the webapp's `ViewerRunDump` (the engine's RunDump is a strict
 * subset of the viewer's looser shape).
 */
export async function runLive(opts: LiveRunOptions): Promise<ViewerRunDump> {
  const { seed, days, onProgress } = opts;

  onProgress?.("loading sql.js…");
  const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });

  onProgress?.("opening database…");
  const db = await openSqlJsDB({ sqlJs: SQL });

  try {
    onProgress?.("seeding world…");
    const { world, skin } = setupWorld(db, { seed, runLengthDays: days });

    const tally = newTally();
    const eventLog: WorldEvent[] = [];
    const snapshots: DaySnapshot[] = [captureSnapshot(db, 0)];
    world.events.subscribe((e) => {
      updateTally(tally, e);
      eventLog.push(e);
      if (e.type === "day.ended") {
        const day = (e as WorldEvent & { day: number }).day;
        snapshots.push(captureSnapshot(db, day));
        onProgress?.(`day ${day}/${days}`);
      }
    });

    onProgress?.("running simulation…");
    world.runToCompletion();

    onProgress?.("building dump…");
    const dump: EngineRunDump = buildRunDump({
      db,
      skin,
      seed,
      tally,
      events: eventLog,
      snapshots,
    });

    return dump as unknown as ViewerRunDump;
  } finally {
    db.close();
  }
}
