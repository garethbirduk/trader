import { useMemo, useState } from "react";
import type { RunDump, RunEvent } from "../types.js";
import type { Selection } from "../App.js";
import { renderEvent } from "./renderEvent.js";

interface Props {
  readonly events: readonly RunEvent[];
  readonly dump: RunDump;
  readonly onSelect: (s: Selection) => void;
}

const HIDE_BY_DEFAULT = new Set([
  "actor.travelled",
  "gossip.exchanged",
  "world.started",
  "world.ended",
  "day.started",
  "day.ended",
]);

export function EventList({ events, dump, onSelect }: Props) {
  const [showChatter, setShowChatter] = useState(false);

  const visible = useMemo(
    () =>
      showChatter
        ? events
        : events.filter((e) => !HIDE_BY_DEFAULT.has(e.type)),
    [events, showChatter],
  );

  return (
    <main className="panel">
      <h2>Events ({visible.length}{!showChatter && events.length !== visible.length ? ` / ${events.length}` : ""})</h2>
      <div className="toggle">
        <label>
          <input
            type="checkbox"
            checked={showChatter}
            onChange={(e) => setShowChatter(e.target.checked)}
          />
          show chatter (travel / gossip / day-start)
        </label>
      </div>
      {visible.length === 0 ? (
        <div className="empty-state">no events on this day</div>
      ) : (
        <div className="events">
          {visible.map((e, i) => (
            <Event key={i} event={e} dump={dump} onSelect={onSelect} />
          ))}
        </div>
      )}
    </main>
  );
}

function Event({
  event,
  dump,
  onSelect,
}: {
  event: RunEvent;
  dump: RunDump;
  onSelect: (s: Selection) => void;
}) {
  const cls = `event event-${event.type.replace(/\./g, "-").replace(/_/g, "_")}`;
  const stamp = `${String(event.at.day).padStart(2, "0")}:${String(event.at.hour).padStart(2, "0")}`;
  const rendered = renderEvent(event, dump, onSelect);
  return (
    <div className={cls}>
      <span className="stamp">D{stamp}</span>
      <span className="type">{event.type}</span>
      {rendered}
    </div>
  );
}
