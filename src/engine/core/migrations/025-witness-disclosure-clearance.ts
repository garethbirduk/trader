import type { Migration } from "../migrations.js";

/**
 * Three intertwined design lanes land in one migration:
 *
 *   #6 — Witnessed events become gossip-able leads. The existing
 *        `leads` table already supports rep-kind leads about an actor
 *        (Stage 5, migration 019). Witness leads piggyback on that
 *        shape: when a "notable" event fires at a venue, every present
 *        non-principal gets a fresh rep lead in their bag. No schema
 *        change needed for the lead row itself — but we extend the
 *        rep-lead semantic with two optional context columns
 *        (`subject_event_type`, `subject_context_json`) so the
 *        witnessed-bribe / witnessed-deal use cases can carry the
 *        narrative payload through gossip.
 *
 *   #7 — Two-tier gossip (headlines vs details). Each lead gains an
 *        optional disclosure list: actors who've paid for the detail
 *        view. The default state for everyone except the holder is
 *        "headline only"; payment promotes them onto the list.
 *
 *   #9 — House clearance opportunities. New stock channel parallel to
 *        the auction docket: morning paper drops a listing (kind +
 *        tier mix, fee, scheduled day), actors phone-book a slot, the
 *        earliest scheduled hour wins, others arrive to nothing.
 */
export const m025WitnessDisclosureClearance: Migration = {
  version: 25,
  name: "witness-disclosure-clearance",
  up(db) {
    db.exec(`
      -- ── #6: Witness event context on leads ───────────────────────
      -- Add optional payload columns to leads so witnessed events
      -- can carry "what happened" through the gossip channel.
      ALTER TABLE leads ADD COLUMN subject_event_type TEXT;
      ALTER TABLE leads ADD COLUMN subject_context_json TEXT;
      CREATE INDEX idx_leads_event_type ON leads(subject_event_type);

      -- ── #7: Two-tier gossip disclosure list ──────────────────────
      -- One row per (lead, actor) the holder has revealed details to.
      -- Holder is implicitly always disclosed to themselves and isn't
      -- recorded here. revealed_at_day is the day the asker paid
      -- (or otherwise unlocked) the detail — used by the UI for
      -- timeline rendering and by autonomy for "I learned this on D3"
      -- staleness checks.
      CREATE TABLE lead_disclosures (
        lead_id          INTEGER NOT NULL REFERENCES leads(id),
        actor_id         INTEGER NOT NULL REFERENCES actors(id),
        revealed_at_day  INTEGER NOT NULL CHECK (revealed_at_day >= 1),
        revealed_by_actor_id INTEGER REFERENCES actors(id),
        cost_paid        INTEGER NOT NULL DEFAULT 0 CHECK (cost_paid >= 0),
        PRIMARY KEY (lead_id, actor_id)
      );
      CREATE INDEX idx_lead_disclosures_actor ON lead_disclosures(actor_id);

      -- ── #9: House clearance listings ─────────────────────────────
      -- One row per "Mrs Smith's house is being cleared" listing. The
      -- newspaper drop announces (listed_day) the listing; bookings
      -- accumulate; the listing resolves at scheduled_hour on
      -- scheduled_day when the earliest booker takes the goods.
      CREATE TABLE clearance_listings (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        listed_day      INTEGER NOT NULL CHECK (listed_day >= 1),
        scheduled_day   INTEGER NOT NULL CHECK (scheduled_day >= 1),
        fee             INTEGER NOT NULL CHECK (fee >= 0),
        flavour         TEXT,
        -- Set when the listing has been resolved (winner picked up).
        -- NULL while still bookable.
        resolved_day    INTEGER,
        resolved_hour   INTEGER,
        -- No FK on winning_booking_id to avoid the circular reference
        -- with clearance_bookings (which is defined below). The id is
        -- still validated at write time in the bookings repo.
        winning_booking_id INTEGER
      );
      CREATE INDEX idx_clearance_listings_day ON clearance_listings(scheduled_day);

      -- Predetermined haul — the lots the winner inherits. Created
      -- with the listing; the engine knows what's there, the bookers
      -- don't until they win.
      CREATE TABLE clearance_listing_lots (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id     INTEGER NOT NULL REFERENCES clearance_listings(id),
        item_kind_id   INTEGER NOT NULL REFERENCES item_kinds(id),
        quality_tier   TEXT    NOT NULL
                          CHECK (quality_tier IN ('mint','good','fair','shoddy','broken')),
        quantity       INTEGER NOT NULL CHECK (quantity > 0)
      );
      CREATE INDEX idx_clearance_listing_lots_listing
        ON clearance_listing_lots(listing_id);

      -- Bookings — phone calls from a venue. scheduled_hour is the
      -- arrival slot the booker chose; earliest hour wins at runtime.
      CREATE TABLE clearance_bookings (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id        INTEGER NOT NULL REFERENCES clearance_listings(id),
        booker_actor_id   INTEGER NOT NULL REFERENCES actors(id),
        booked_day        INTEGER NOT NULL CHECK (booked_day >= 1),
        booked_hour       INTEGER NOT NULL CHECK (booked_hour BETWEEN 0 AND 23),
        scheduled_hour    INTEGER NOT NULL CHECK (scheduled_hour BETWEEN 0 AND 23),
        booked_at_location_id INTEGER REFERENCES locations(id),
        outcome           TEXT CHECK (outcome IN ('won','arrived-empty','no-show')),
        UNIQUE (listing_id, booker_actor_id)
      );
      CREATE INDEX idx_clearance_bookings_listing
        ON clearance_bookings(listing_id);
      CREATE INDEX idx_clearance_bookings_booker
        ON clearance_bookings(booker_actor_id);
    `);
  },
};
