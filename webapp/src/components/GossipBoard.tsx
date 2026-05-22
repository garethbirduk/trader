import { useMemo, useState } from "react";
import type { DaySnapshot, RunDump } from "../types.js";
import type { Selection } from "../App.js";
import { ActorChipById } from "./ActorChip.js";
import { LocationLink } from "./Links.js";
import { CategoryTag, StockChip } from "./StockChip.js";
import { useSelectionSet } from "../lib/selection-set.js";
import { usePov } from "../lib/pov.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly hour: number;
  readonly snapshot: DaySnapshot | null;
  readonly onSelect: (s: Selection) => void;
}

interface RawExchange {
  readonly fromActorId: number;
  readonly toActorId: number;
  readonly lead: {
    readonly kind: "commodity" | "rep";
    readonly side: "supply" | "demand";
    readonly subjectItemKindId: number | null;
    readonly subjectTargetActorId: number | null;
    readonly counterpartyActorId: number | null;
  };
}

/** Flat line — one row per exchange (speaker → listener pair, single
 *  lead). Carries everything any grouping needs in its header without
 *  re-walking the event log. */
interface GossipLine {
  readonly day: number;
  readonly hour: number;
  readonly locId: number;
  readonly fromActorId: number;
  readonly toActorId: number;
  readonly subjectActorId: number | null;
  readonly itemKindId: number | null;
  readonly category: string | null;
  readonly kind: "commodity" | "rep";
  readonly side: "supply" | "demand";
}

type Grouping = "item" | "type" | "source" | "target";
const GROUPINGS: readonly Grouping[] = ["item", "type", "source", "target"];
const GROUPING_KEY = "trader-gossip-grouping";

function readGrouping(): Grouping {
  try {
    const raw = localStorage.getItem(GROUPING_KEY);
    if (
      raw === "item" ||
      raw === "type" ||
      raw === "source" ||
      raw === "target"
    ) {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return "item";
}

function writeGrouping(g: Grouping): void {
  try {
    localStorage.setItem(GROUPING_KEY, g);
  } catch {
    /* ignore */
  }
}

function subjectActorIdOf(x: RawExchange): number | null {
  const lead = x.lead;
  if (lead.kind === "commodity") {
    return lead.counterpartyActorId ?? x.fromActorId;
  }
  return lead.subjectTargetActorId;
}

/**
 * Cumulative gossip log up to the current cursor (day, hour), grouped
 * by the chosen axis (item / type / source / target). Same per-exchange
 * filtering as the SceneDeck's GossipScene: player POV → received-only,
 * admin + selected actors → lines touching a selected actor on either
 * side. Within each encounter, exchanges are deduped on (speaker, kind,
 * side, subject) so chat + clarification firing on the same content
 * don't double up.
 */
export function GossipBoard({ dump, day, hour, snapshot, onSelect }: Props) {
  void snapshot;
  void onSelect;
  const { pov } = usePov();
  const set = useSelectionSet();
  const toggle = (s: Selection): void => set.toggle(s);
  const [grouping, setGroupingState] = useState<Grouping>(() => readGrouping());
  const setGrouping = (g: Grouping): void => {
    setGroupingState(g);
    writeGrouping(g);
  };

  const povActorId = pov.kind === "actor" ? pov.actorId : null;
  const focusActorIds = useMemo<ReadonlySet<number>>(() => {
    const out = new Set<number>();
    for (const s of set.items) {
      if (s.kind === "actor") out.add(s.id);
    }
    return out;
  }, [set.items]);

  const itemCategoryById = useMemo<ReadonlyMap<number, string>>(() => {
    const m = new Map<number, string>();
    for (const it of dump.items) m.set(it.id, it.category);
    return m;
  }, [dump.items]);

  const lines = useMemo<readonly GossipLine[]>(() => {
    const out: GossipLine[] = [];
    for (const e of dump.events) {
      if (e.type !== "gossip.exchanged") continue;
      if (e.at.day > day) continue;
      if (e.at.day === day && e.at.hour > hour) continue;
      const xs = (e.exchanges as readonly RawExchange[] | undefined) ?? [];
      // Dedupe per encounter on (speaker, kind, side, subject) so chat
      // + clarification firing on the same content collapse.
      const seen = new Set<string>();
      for (const x of xs) {
        const subj = subjectActorIdOf(x);
        if (subj !== null && subj === x.toActorId) continue;
        if (povActorId !== null) {
          if (x.toActorId !== povActorId) continue;
        } else if (focusActorIds.size > 0) {
          if (
            !focusActorIds.has(x.fromActorId) &&
            !focusActorIds.has(x.toActorId)
          ) {
            continue;
          }
        }
        const subjectKey =
          x.lead.subjectItemKindId !== null
            ? `i${x.lead.subjectItemKindId}`
            : x.lead.subjectTargetActorId !== null
              ? `a${x.lead.subjectTargetActorId}`
              : "u";
        const dedupKey = `${x.fromActorId}|${x.lead.kind}|${x.lead.side}|${subjectKey}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        const itemId = x.lead.subjectItemKindId;
        out.push({
          day: e.at.day,
          hour: e.at.hour,
          locId: e.atLocationId as number,
          fromActorId: x.fromActorId,
          toActorId: x.toActorId,
          subjectActorId: subj,
          itemKindId: itemId,
          category: itemId !== null ? itemCategoryById.get(itemId) ?? null : null,
          kind: x.lead.kind,
          side: x.lead.side,
        });
      }
    }
    return out;
  }, [dump.events, day, hour, povActorId, focusActorIds, itemCategoryById]);

  if (lines.length === 0) {
    return (
      <div className="empty-state">
        no gossip yet
        {focusActorIds.size > 0 || povActorId !== null
          ? " (try clearing the selection or switching to admin)"
          : ""}
      </div>
    );
  }

  return (
    <section className="gossip-board">
      <GossipGroupingTabs grouping={grouping} onChange={setGrouping} />
      <header className="gossip-board-header muted">
        {lines.length} line{lines.length === 1 ? "" : "s"}
        {" · through D"}
        {String(day).padStart(2, "0")}
        {" "}
        {String(hour).padStart(2, "0")}
        {":00"}
      </header>
      <GossipGrouped
        dump={dump}
        lines={lines}
        grouping={grouping}
        toggle={toggle}
      />
    </section>
  );
}

function GossipGroupingTabs({
  grouping,
  onChange,
}: {
  grouping: Grouping;
  onChange: (g: Grouping) => void;
}) {
  return (
    <div className="stock-grouping" role="tablist" aria-label="Gossip grouping">
      {GROUPINGS.map((g) => (
        <button
          key={g}
          type="button"
          className={`stock-grouping-btn ${grouping === g ? "active" : ""}`}
          onClick={() => onChange(g)}
        >
          by {g}
        </button>
      ))}
    </div>
  );
}

interface GossipGroup {
  readonly key: string;
  readonly header: { kind: "item" | "category" | "actor"; id: number | string };
  readonly lines: GossipLine[];
}

function GossipGrouped({
  dump,
  lines,
  grouping,
  toggle,
}: {
  readonly dump: RunDump;
  readonly lines: readonly GossipLine[];
  readonly grouping: Grouping;
  readonly toggle: (s: Selection) => void;
}) {
  const groups = useMemo<readonly GossipGroup[]>(() => {
    const map = new Map<string, GossipGroup>();
    const orphan: GossipLine[] = [];
    for (const l of lines) {
      let key: string | null = null;
      let header: GossipGroup["header"] | null = null;
      if (grouping === "item") {
        if (l.itemKindId === null) {
          orphan.push(l);
          continue;
        }
        key = `i${l.itemKindId}`;
        header = { kind: "item", id: l.itemKindId };
      } else if (grouping === "type") {
        if (l.category === null) {
          orphan.push(l);
          continue;
        }
        key = `c${l.category}`;
        header = { kind: "category", id: l.category };
      } else if (grouping === "source") {
        key = `a${l.fromActorId}`;
        header = { kind: "actor", id: l.fromActorId };
      } else {
        // target
        if (l.subjectActorId === null) {
          orphan.push(l);
          continue;
        }
        key = `a${l.subjectActorId}`;
        header = { kind: "actor", id: l.subjectActorId };
      }
      let g = map.get(key);
      if (g === undefined) {
        g = { key, header, lines: [] };
        map.set(key, g);
      }
      g.lines.push(l);
    }
    const out = [...map.values()];
    // Sort groups by header label, then sort lines within newest-first.
    out.sort((a, b) => {
      const la = groupLabel(dump, a.header);
      const lb = groupLabel(dump, b.header);
      return la.localeCompare(lb);
    });
    for (const g of out) {
      g.lines.sort((a, b) =>
        a.day !== b.day ? b.day - a.day : b.hour - a.hour,
      );
    }
    if (orphan.length > 0) {
      orphan.sort((a, b) =>
        a.day !== b.day ? b.day - a.day : b.hour - a.hour,
      );
      out.push({
        key: "orphan",
        header: { kind: "category", id: "(no subject)" },
        lines: orphan,
      });
    }
    return out;
  }, [lines, grouping, dump]);

  return (
    <ul className="gossip-board-groups">
      {groups.map((g) => (
        <li key={g.key} className="gossip-board-group">
          <div className="gossip-board-group-header">
            <GroupHeader dump={dump} header={g.header} toggle={toggle} />
            <span className="muted">
              {" · "}
              {g.lines.length} line{g.lines.length === 1 ? "" : "s"}
            </span>
          </div>
          <ul className="gossip-board-lines">
            {g.lines.map((l, i) => (
              <GossipLineRow
                key={i}
                dump={dump}
                line={l}
                grouping={grouping}
                toggle={toggle}
              />
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function groupLabel(
  dump: RunDump,
  header: GossipGroup["header"],
): string {
  if (header.kind === "item") {
    const it = dump.items.find((i) => i.id === header.id);
    return it?.displayName ?? `item#${header.id}`;
  }
  if (header.kind === "category") {
    return String(header.id);
  }
  const a = dump.actors.find((x) => x.id === header.id);
  return a?.firstName ?? a?.code ?? `actor#${header.id}`;
}

function GroupHeader({
  dump,
  header,
  toggle,
}: {
  readonly dump: RunDump;
  readonly header: GossipGroup["header"];
  readonly toggle: (s: Selection) => void;
}) {
  if (header.kind === "item") {
    const id = header.id as number;
    return (
      <StockChip
        dump={dump}
        itemKindId={id}
        qualityTier={null}
        quantity={null}
        observerActorId={null}
        onSelect={toggle}
      />
    );
  }
  if (header.kind === "category") {
    return <CategoryTag category={String(header.id)} onSelect={toggle} />;
  }
  return (
    <ActorChipById
      dump={dump}
      actorId={header.id as number}
      onSelect={toggle}
      size={16}
    />
  );
}

/**
 * One gossip line row. The grouping axis determines which entity is
 * the header (and thus suppressed from the row to avoid repetition).
 * E.g. "by source" drops the speaker chip from each row; "by item"
 * drops the item chip.
 */
function GossipLineRow({
  dump,
  line,
  grouping,
  toggle,
}: {
  readonly dump: RunDump;
  readonly line: GossipLine;
  readonly grouping: Grouping;
  readonly toggle: (s: Selection) => void;
}) {
  const verb =
    line.kind === "commodity"
      ? line.side === "supply"
        ? "has"
        : "wants"
      : "— bad rep";
  const showSpeaker = grouping !== "source";
  const showSubject = grouping !== "target";
  const showItem = grouping !== "item" && line.itemKindId !== null;
  return (
    <li className="gossip-board-line">
      <span className="gossip-board-when muted">
        D{String(line.day).padStart(2, "0")}
        {" "}
        {String(line.hour).padStart(2, "0")}
        :00
      </span>
      {showSpeaker ? (
        <ActorChipById
          dump={dump}
          actorId={line.fromActorId}
          onSelect={toggle}
          size={14}
        />
      ) : null}
      <span className="muted">→</span>
      <ActorChipById
        dump={dump}
        actorId={line.toActorId}
        onSelect={toggle}
        size={14}
      />
      <span className="muted">:</span>
      {showSubject && line.subjectActorId !== null ? (
        <>
          <ActorChipById
            dump={dump}
            actorId={line.subjectActorId}
            onSelect={toggle}
            size={14}
          />
        </>
      ) : null}
      <span className="muted">{verb}</span>
      {showItem && line.itemKindId !== null ? (
        <StockChip
          dump={dump}
          itemKindId={line.itemKindId}
          qualityTier={null}
          quantity={null}
          observerActorId={null}
          onSelect={toggle}
        />
      ) : null}
      <span className="muted">at</span>
      <LocationLink dump={dump} locationId={line.locId} onSelect={toggle} />
    </li>
  );
}
