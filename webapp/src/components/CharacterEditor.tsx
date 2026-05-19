import { useEffect, useMemo, useState } from "react";
import { Avatar } from "./Avatar.js";

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
  // Everything else passes through untouched.
  readonly [key: string]: unknown;
}

interface LocationLite {
  readonly code: string;
  readonly displayName: string;
}

interface DraftActor {
  readonly code: string;
  firstName: string;
  lastName: string;
  shortName: string;
  homeLocation: string;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; dirty: boolean }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

export function CharacterEditor() {
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
        d.homeLocation !== a.homeLocation
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
    const entries = [...map.entries()].map(([homeCode, members]) => ({
      homeCode,
      homeDisplayName:
        locByCode.get(homeCode)?.displayName ?? homeCode,
      members: members.slice().sort((a, b) => a.code.localeCompare(b.code)),
    }));
    entries.sort((a, b) => a.homeDisplayName.localeCompare(b.homeDisplayName));
    return entries;
  }, [drafts, locations]);

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
      };
    }
    setDrafts(reset);
  };

  const onSave = async () => {
    if (raw === null) return;
    setStatus({ kind: "saving" });
    try {
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
        {grouped.map(({ homeCode, homeDisplayName, members }) => (
          <section key={homeCode} className="char-household">
            <header className="char-household-header">
              <span className="char-household-name">{homeDisplayName}</span>
              <span className="muted">
                {members.length}
                {" · "}
                <code>{homeCode}</code>
              </span>
            </header>
            <ul className="char-household-list">
              {members.map((d) => {
                const isDirty = dirtyCodes.has(d.code);
                const composed =
                  d.lastName.length > 0
                    ? `${d.firstName} ${d.lastName}`
                    : d.firstName;
                return (
                  <li
                    key={d.code}
                    className={`char-row ${isDirty ? "char-row-dirty" : ""}`}
                  >
                    <Avatar
                      name={composed}
                      code={d.code}
                      isPlayer={false}
                      size={20}
                    />
                    <code className="char-code muted">{d.code}</code>
                    <input
                      className="char-input"
                      value={d.firstName}
                      placeholder="first"
                      onChange={(e) =>
                        onFieldChange(d.code, "firstName", e.target.value)
                      }
                    />
                    <input
                      className="char-input"
                      value={d.lastName}
                      placeholder="last (opt)"
                      onChange={(e) =>
                        onFieldChange(d.code, "lastName", e.target.value)
                      }
                    />
                    <input
                      className="char-input"
                      value={d.shortName}
                      placeholder="short"
                      onChange={(e) =>
                        onFieldChange(d.code, "shortName", e.target.value)
                      }
                    />
                    <select
                      className="char-select"
                      value={d.homeLocation}
                      onChange={(e) =>
                        onFieldChange(d.code, "homeLocation", e.target.value)
                      }
                    >
                      {locations.map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.displayName} ({l.code})
                        </option>
                      ))}
                    </select>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}
