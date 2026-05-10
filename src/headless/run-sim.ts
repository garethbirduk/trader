import { parseArgs } from "node:util";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openBetterSqlite3DB } from "../engine/core/db-better-sqlite3.js";
import { setupWorld } from "../engine/setup.js";
import {
  buildRunDump,
  captureSnapshot,
  newTally,
  updateTally,
  type DaySnapshot,
  type RunDump,
  type RunTally,
} from "../engine/snapshot.js";
import { consoleHandler, type WorldEvent } from "../engine/core/events.js";
import {
  getActorByCode,
  getActorById,
} from "../engine/actors/actors-repo.js";
import { getDealsByState } from "../engine/deals/deals-repo.js";

interface CliOptions {
  days: number | null;
  seed: string;
  dbPath: string;
  quiet: boolean;
  out: string | null;
}

function parseCli(argv: readonly string[]): CliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      days: { type: "string" },
      seed: { type: "string", default: "default" },
      db: { type: "string", default: ":memory:" },
      quiet: { type: "boolean", default: false },
      out: { type: "string" },
    },
    strict: true,
  });
  const daysStr = values.days as string | undefined;
  const days = daysStr === undefined ? null : Number.parseInt(daysStr, 10);
  if (days !== null && (!Number.isInteger(days) || days < 1)) {
    throw new Error(`--days must be a positive integer; got ${daysStr}`);
  }
  return {
    days,
    seed: values.seed as string,
    dbPath: values.db as string,
    quiet: values.quiet as boolean,
    out: (values.out as string | undefined) ?? null,
  };
}

function main(): void {
  const opts = parseCli(process.argv.slice(2));
  const db = openBetterSqlite3DB({ filename: opts.dbPath });
  try {
    const { world, skin } = setupWorld(db, {
      seed: opts.seed,
      ...(opts.days !== null ? { runLengthDays: opts.days } : {}),
    });

    if (!opts.quiet) {
      world.events.subscribe(consoleHandler());
    }

    const tally = newTally();
    world.events.subscribe((e) => updateTally(tally, e));

    // If --out is set, capture every event into a buffer plus an
    // end-of-day snapshot of the world's tabular state. A "day 0"
    // snapshot taken right after seeding lets the webapp show
    // pre-day-1 actor positions correctly.
    const eventLog: WorldEvent[] = [];
    const snapshots: DaySnapshot[] = [];
    if (opts.out !== null) {
      snapshots.push(captureSnapshot(db, 0));
      world.events.subscribe((e) => {
        eventLog.push(e);
        if (e.type === "day.ended") {
          snapshots.push(captureSnapshot(db, e.day));
        }
      });
    }

    world.runToCompletion();

    printReport(db, skin.playerActorId, tally);

    if (opts.out !== null) {
      const dump = buildRunDump({
        db,
        skin,
        seed: opts.seed,
        tally,
        events: eventLog,
        snapshots,
      });
      writeRunDump(opts.out, dump);
      console.log(`\nrun dumped to ${opts.out}`);
    }
  } finally {
    db.close();
  }
}

function writeRunDump(path: string, dump: RunDump): void {
  const dir = dirname(path);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(dump, null, 2));
}

function printReport(
  db: ReturnType<typeof openBetterSqlite3DB>,
  playerActorId: number,
  tally: RunTally,
): void {
  console.log("");
  console.log("=== run report ===");
  const player = getActorById(db, playerActorId);
  console.log(`player cash:            £${player?.cash ?? "?"}`);
  const house = getActorByCode(db, "auction-house");
  console.log(`auction house revenue:  £${house?.cash ?? "?"}`);
  console.log(`pool flushes:           ${tally.poolFlushed}`);
  console.log(`pool claims:            ${tally.poolClaimed}`);
  console.log(`auctions cleared:       ${tally.auctionCleared}`);
  console.log(`auctions unsold:        ${tally.auctionUnsold}`);
  console.log(`deals settled:          ${tally.dealsSettled}`);
  console.log(`deals defaulted:        ${tally.dealsDefaulted}`);
  console.log(`pubdeals attempted:     ${tally.pubdealsAttempted}`);
  console.log(`pubdeals agreed:        ${tally.pubdealsAgreed}`);
  console.log(`pubdeals walked:        ${tally.pubdealsWalked}`);

  const orphanAgreed = getDealsByState(db, "agreed");
  if (orphanAgreed.length > 0) {
    console.log(`orphan agreed deals:    ${orphanAgreed.length} (deadline > runLength)`);
  }
}

main();
