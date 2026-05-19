import { useEffect, useMemo, useState } from "react";
import { Avatar } from "./Avatar.js";
import { LocationChip } from "./LocationChip.js";
import { LocationPicker } from "./LocationPicker.js";
import { deriveRoutineFromVenue } from "../lib/routine-from-hours.js";

/**
 * Character editor — dogfooding surface for tuning routines and
 * relationships. v1 scope: edit firstName / lastName / shortName and
 * the household (homeLocation) per actor. Grouped by household so the
 * structure of who-lives-with-whom is readable at a glance.
 *
 * Loads `actors.json` via `/__data?file=actors.json` (dev-mode Vite
 * middleware), edits in memory, POSTs the whole file back on Save. The
 * user re-runs `npm run sim` to re-bake events.json.
 */

interface ActorRecord {
  readonly code: string;
  readonly firstName: string;
  readonly lastName?: string;
  readonly shortName: string;
  readonly homeLocation: string;
  readonly ownsLocation?: string;
  readonly worksAt?: string;
  // Everything else passes through untouched.
  readonly [key: string]: unknown;
}

interface LocationLite {
  readonly code: string;
  readonly displayName: string;
  readonly type?: string;
  /** Per-day opening sessions; preferred over openHours when present.
   *  Used by the auto-routine derivation when an actor's worksAt is
   *  set or changed. */
  readonly openSessions?: ReadonlyArray<{
    daysOfWeek: readonly number[];
    start: number;
    end: number;
  }>;
  readonly openHours?: { start: number; end: number } | null;
  readonly openDaysOfWeek?: readonly number[];
}

/** Group locations by `type` for use as <optgroup> blocks. */
function groupByType(locs: readonly LocationLite[]): {
  type: string;
  label: string;
  items: readonly LocationLite[];
}[] {
  const groups: Record<string, LocationLite[]> = {};
  for (const l of locs) {
    const t = l.type ?? "(other)";
    (groups[t] ??= []).push(l);
  }
  const TYPE_LABELS: Record<string, string> = {
    home: "Residential",
    business: "Business",
    pub: "Pub",
    auction: "Auction",
    civic: "Service",
    street: "Street",
    abstract: "(abstract)",
    "(other)": "(other)",
  };
  // Stable, readable order in the dropdown.
  const ORDER = ["home", "business", "pub", "auction", "civic", "street", "abstract", "(other)"];
  return ORDER.filter((t) => groups[t] !== undefined).map((t) => ({
    type: t,
    label: TYPE_LABELS[t] ?? t,
    items: groups[t]!.slice().sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    ),
  }));
}

/** Which location-types are valid for each editable field. */
const ALLOWED_TYPES: Record<"homeLocation" | "ownsLocation" | "worksAt", readonly string[]> = {
  homeLocation: ["home"],
  ownsLocation: ["business", "pub", "auction"],
  worksAt: ["business", "pub", "auction", "civic"],
};

interface DraftActor {
  readonly code: string;
  firstName: string;
  lastName: string;
  shortName: string;
  homeLocation: string;
  /** Empty string = unset (we delete the field on save). */
  ownsLocation: string;
  /** Empty string = unset (we delete the field on save). */
  worksAt: string;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; dirty: boolean }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

export type CharacterEditorView = "residences" | "actors";

export function CharacterEditor({ view = "residences" }: { view?: CharacterEditorView } = {}) {
  const [raw, setRaw] = useState<readonly ActorRecord[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftActor>>({});
  const [locations, setLocations] = useState<readonly LocationLite[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setStatus({ kind: "loading" });
      try {
        const [actorsRes, locsRes] = await Promise.all([
          fetch("/__data?file=actors.json"),
          fetch("/__data?file=locations.json"),
        ]);
        if (!actorsRes.ok || !locsRes.ok) {
          throw new Error(
            `load failed (actors ${actorsRes.status}, locations ${locsRes.status})`,
          );
        }
        const actors = (await actorsRes.json()) as readonly ActorRecord[];
        const locs = (await locsRes.json()) as readonly LocationLite[];
        if (cancelled) return;
        setRaw(actors);
        setLocations(locs);
        const initialDrafts: Record<string, DraftActor> = {};
        for (const a of actors) {
          initialDrafts[a.code] = {
            code: a.code,
            firstName: a.firstName,
            lastName: a.lastName ?? "",
            shortName: a.shortName,
            homeLocation: a.homeLocation,
            ownsLocation: a.ownsLocation ?? "",
            worksAt: a.worksAt ?? "",
          };
        }
        setDrafts(initialDrafts);
        setStatus({ kind: "ready", dirty: false });
      } catch (e) {
        if (!cancelled) setStatus({ kind: "error", message: String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dirtyCodes = useMemo(() => {
    if (raw === null) return new Set<string>();
    const out = new Set<string>();
    for (const a of raw) {
      const d = drafts[a.code];
      if (d === undefined) continue;
      if (
        d.firstName !== a.firstName ||
        d.lastName !== (a.lastName ?? "") ||
        d.shortName !== a.shortName ||
        d.homeLocation !== a.homeLocation ||
        d.ownsLocation !== (a.ownsLocation ?? "") ||
        d.worksAt !== (a.worksAt ?? "")
      ) {
        out.add(a.code);
      }
    }
    return out;
  }, [raw, drafts]);

  useEffect(() => {
    if (status.kind === "ready" || status.kind === "saved") {
      setStatus({ kind: "ready", dirty: dirtyCodes.size > 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirtyCodes.size]);

  const grouped = useMemo(() => {
    const map = new Map<string, DraftActor[]>();
    for (const d of Object.values(drafts)) {
      const list = map.get(d.homeLocation) ?? [];
      list.push(d);
      map.set(d.homeLocation, list);
    }
    const locByCode = new Map(locations.map((l) => [l.code, l]));
    const entries = [...map.entries()].map(([homeCode, members]) => {
      const loc = locByCode.get(homeCode);
      return {
        homeCode,
        homeDisplayName: loc?.displayName ?? homeCode,
        homeType: loc?.type,
        members: members.slice().sort((a, b) => a.code.localeCompare(b.code)),
      };
    });
    entries.sort((a, b) => a.homeDisplayName.localeCompare(b.homeDisplayName));
    return entries;
  }, [drafts, locations]);

  // Flat list view — every actor, sorted alphabetically by composed
  // display name. Used by the Actors sub-tab where grouping by household
  // would obscure the cast-wide alphabetical view.
  const flatActors = useMemo(() => {
    const composedFor = (d: DraftActor) =>
      d.lastName.length > 0 ? `${d.firstName} ${d.lastName}` : d.firstName;
    return Object.values(drafts).slice().sort((a, b) =>
      composedFor(a).localeCompare(composedFor(b)),
    );
  }, [drafts]);

  const onFieldChange = (
    code: string,
    field: keyof Omit<DraftActor, "code">,
    value: string,
  ) => {
    setDrafts((prev) => ({
      ...prev,
      [code]: { ...prev[code]!, [field]: value },
    }));
  };

  const onRevert = () => {
    if (raw === null) return;
    const reset: Record<string, DraftActor> = {};
    for (const a of raw) {
      reset[a.code] = {
        code: a.code,
        firstName: a.firstName,
        lastName: a.lastName ?? "",
        shortName: a.shortName,
        homeLocation: a.homeLocation,
        ownsLocation: a.ownsLocation ?? "",
        worksAt: a.worksAt ?? "",
      };
    }
    setDrafts(reset);
  };

  const onSave = async () => {
    if (raw === null) return;
    setStatus({ kind: "saving" });
    try {
      const venueByCode = new Map(locations.map((l) => [l.code, l]));
      const updated: ActorRecord[] = raw.map((a) => {
        const d = drafts[a.code];
        if (d === undefined) return a;
        const next: Record<string, unknown> = { ...a };
        next.firstName = d.firstName;
        if (d.lastName.length === 0) {
          delete next.lastName;
        } else {
          next.lastName = d.lastName;
        }
        next.shortName = d.shortName;
        next.homeLocation = d.homeLocation;
        if (d.ownsLocation.length === 0) {
          delete next.ownsLocation;
        } else {
          next.ownsLocation = d.ownsLocation;
        }
        // When worksAt changes (newly set or repointed to a different
        // venue), regenerate the actor's routine from the venue's
        // opening hours. Clearing worksAt leaves the existing routine
        // alone — the user may want to keep custom spans.
        const prevWorksAt = a.worksAt ?? "";
        const newWorksAt = d.worksAt;
        if (newWorksAt.length === 0) {
          delete next.worksAt;
        } else {
          next.worksAt = newWorksAt;
          if (newWorksAt !== prevWorksAt) {
            const venue = venueByCode.get(newWorksAt);
            if (venue !== undefined) {
              const r = deriveRoutineFromVenue(newWorksAt, venue);
              next.schedule = r.schedule;
              if (r.weekendSchedule.length > 0) {
                next.weekendSchedule = r.weekendSchedule;
              } else {
                delete next.weekendSchedule;
              }
            }
          }
        }
        return next as ActorRecord;
      });
      const res = await fetch("/__data?file=actors.json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated),
      });
      if (!res.ok) {
        throw new Error(`save failed (${res.status})`);
      }
      setRaw(updated);
      setStatus({ kind: "saved" });
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  };

  if (status.kind === "loading" || status.kind === "idle") {
    return <div className="char-editor-status muted">Loading actors…</div>;
  }
  if (status.kind === "error") {
    return <div className="char-editor-status error">Error: {status.message}</div>;
  }

  const dirty = dirtyCodes.size > 0;

  return (
    <section className="char-editor">
      <header className="char-editor-bar">
        <span className="char-editor-title">Character editor</span>
        <span className="char-editor-stats muted">
          {Object.keys(drafts).length} actors · {grouped.length} households
        </span>
        <span className="char-editor-spacer" />
        {status.kind === "saved" && !dirty ? (
          <span className="char-editor-saved">
            Saved. Run <code>npm run sim -- --out webapp/public/events.json</code> then reload.
          </span>
        ) : null}
        <button
          type="button"
          className="char-editor-revert"
          onClick={onRevert}
          disabled={!dirty}
          title="Discard unsaved changes"
        >
          Revert
        </button>
        <button
          type="button"
          className="char-editor-save"
          onClick={onSave}
          disabled={!dirty || status.kind === "saving"}
        >
          {status.kind === "saving"
            ? "Saving…"
            : dirty
              ? `Save (${dirtyCodes.size})`
              : "Saved"}
        </button>
      </header>
      <div className="char-editor-body">
        <div className="char-row char-row-headers" aria-hidden="true">
          <span />
          <span className="char-col-label">code</span>
          <span className="char-col-label">first name</span>
          <span className="char-col-label">last name</span>
          <span className="char-col-label">short name</span>
          <span className="char-col-label">household</span>
          <span className="char-col-label">owns</span>
          <span className="char-col-label">works at</span>
        </div>
        {view === "actors" ? (
          <ul className="char-household-list">
            {flatActors.map((d) => (
              <ActorRow
                key={d.code}
                d={d}
                isDirty={dirtyCodes.has(d.code)}
                locations={locations}
                onFieldChange={onFieldChange}
              />
            ))}
          </ul>
        ) : (
          grouped.map(({ homeCode, homeDisplayName, homeType, members }) => (
          <section key={homeCode} className="char-household">
            <header className="char-household-header">
              <LocationChip
                loc={{ code: homeCode, displayName: homeDisplayName, ...(homeType !== undefined ? { type: homeType } : {}) }}
                detail="full"
                size={18}
              />
              <span className="muted">{members.length}</span>
            </header>
            <ul className="char-household-list">
              {members.map((d) => (
                <ActorRow
                  key={d.code}
                  d={d}
                  isDirty={dirtyCodes.has(d.code)}
                  locations={locations}
                  onFieldChange={onFieldChange}
                />
              ))}
            </ul>
          </section>
          ))
        )}
      </div>
    </section>
  );
}

/** Per-actor editable row — used by both the grouped Residences view
 *  and the flat Actors view so the cell layout and behaviour stay
 *  identical between them. */
function ActorRow({
  d,
  isDirty,
  locations,
  onFieldChange,
}: {
  d: DraftActor;
  isDirty: boolean;
  locations: readonly LocationLite[];
  onFieldChange: (code: string, field: keyof Omit<DraftActor, "code">, value: string) => void;
}) {
  const composed = d.lastName.length > 0 ? `${d.firstName} ${d.lastName}` : d.firstName;
  return (
    <li className={`char-row ${isDirty ? "char-row-dirty" : ""}`}>
      <Avatar name={composed} code={d.code} isPlayer={false} size={20} />
      <code className="char-code muted">{d.code}</code>
      <input
        className="char-input"
        value={d.firstName}
        placeholder="first"
        onChange={(e) => onFieldChange(d.code, "firstName", e.target.value)}
      />
      <input
        className="char-input"
        value={d.lastName}
        placeholder="last (opt)"
        onChange={(e) => onFieldChange(d.code, "lastName", e.target.value)}
      />
      <input
        className="char-input"
        value={d.shortName}
        placeholder="short"
        onChange={(e) => onFieldChange(d.code, "shortName", e.target.value)}
      />
      <LocationSelect
        kind="homeLocation"
        value={d.homeLocation}
        locations={locations}
        onChange={(v) => onFieldChange(d.code, "homeLocation", v)}
      />
      <LocationSelect
        kind="ownsLocation"
        value={d.ownsLocation}
        locations={locations}
        onChange={(v) => onFieldChange(d.code, "ownsLocation", v)}
      />
      <LocationSelect
        kind="worksAt"
        value={d.worksAt}
        locations={locations}
        onChange={(v) => onFieldChange(d.code, "worksAt", v)}
      />
    </li>
  );
}

/**
 * Chip-styled location picker for the three relation fields. Filters by
 * the field's allowed location types (residential / business / service /
 * pub / auction), groups options under category headers, renders every
 * option as a chip (avatar + name + code).
 *
 * `homeLocation` requires a value; `ownsLocation` and `worksAt` are
 * nullable so the picker includes a leading "— none —" option that
 * maps to "delete the field" on save.
 */
function LocationSelect({
  kind,
  value,
  locations,
  onChange,
}: {
  kind: "homeLocation" | "ownsLocation" | "worksAt";
  value: string;
  locations: readonly LocationLite[];
  onChange: (v: string) => void;
}) {
  const allowed = new Set(ALLOWED_TYPES[kind]);
  const filtered = locations.filter((l) =>
    l.type !== undefined ? allowed.has(l.type) : false,
  );
  const groups = groupByType(filtered).map((g) => ({
    label: g.label,
    items: g.items,
  }));
  return (
    <LocationPicker
      value={value}
      groups={groups}
      nullable={kind !== "homeLocation"}
      onChange={onChange}
    />
  );
}
