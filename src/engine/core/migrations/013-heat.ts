import type { Migration } from "../migrations.js";

/**
 * Heat tracks how visible an actor is to authorities. Every transaction
 * involving stolen / dangerous goods bumps both parties' scores; heat
 * decays over time when actors keep their nose clean. Once an actor's
 * heat crosses a threshold, the authority sweep starts paying them
 * attention — raids on stolen inventory, fines, and (in future) arrests.
 *
 * Engine-agnostic: skins decide which actor receives fine proceeds
 * (typically a "police" actor or the auction-house sink), what the
 * thresholds are, and when authority actors actually visit.
 */
export const m013Heat: Migration = {
  version: 13,
  name: "actor-heat",
  up(db) {
    db.exec(`
      CREATE TABLE actor_heat (
        actor_id        INTEGER PRIMARY KEY REFERENCES actors(id),
        score           INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),
        last_event_day  INTEGER
      );
    `);
  },
};
