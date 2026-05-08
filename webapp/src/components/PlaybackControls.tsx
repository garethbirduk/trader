import { useEffect, useRef, useState } from "react";
import {
  setPlaybackSpeed,
  useMapBusy,
} from "../anim-state.js";
import type { RunDump } from "../types.js";

interface Props {
  readonly day: number;
  readonly hour: number;
  readonly maxDay: number;
  readonly dump: RunDump;
  readonly onChange: (day: number, hour: number) => void;
}

/** Speed multipliers — scale both the avatar walk speed (in MapGraph
 *  via getPlaybackSpeed()) and the per-hour interaction-pause delay. */
const SPEEDS: ReadonlyArray<{ label: string; mult: number }> = [
  { label: "0.5×", mult: 0.5 },
  { label: "1×", mult: 1 },
  { label: "2×", mult: 2 },
  { label: "4×", mult: 4 },
];

/** Base delay (at 1×) for the "interact" phase after avatars arrive. */
const BASE_INTERACT_MS = 280;
/** Extra ms per event happening this hour, capped to keep busy hours
 *  from dragging on forever. */
const PER_EVENT_MS = 70;
const MAX_INTERACT_MS = 1200;

type Phase = "transit" | "interact";

export function PlaybackControls({
  day, hour, maxDay, dump, onChange,
}: Props) {
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(1);
  const [phase, setPhase] = useState<Phase>("transit");
  const dayRef = useRef(day);
  const hourRef = useRef(hour);
  dayRef.current = day;
  hourRef.current = hour;
  const mapBusy = useMapBusy();

  const speed = SPEEDS[speedIdx]!.mult;
  const atEnd = day >= maxDay && hour >= 23;

  // Push the speed multiplier into the global anim-state so MapGraph's
  // walk-rate scales with it.
  useEffect(() => {
    setPlaybackSpeed(speed);
  }, [speed]);

  // Number of "interaction" events at the current hour (used to size
  // the interact pause). actor.departed / actor.travelled are travel
  // bookkeeping — we count everything else.
  const interactionCount = countInteractions(dump, day, hour);

  // Phase-driven playback loop.
  //
  //   1. transit   — wait until MapGraph reports mapBusy=false (every
  //                  avatar has finished its walk).
  //   2. interact  — pause for BASE_INTERACT_MS + interactionCount ×
  //                  PER_EVENT_MS, scaled by speed, so the user sees
  //                  the hour's events register.
  //   3. advance one hour, flip back to transit.
  useEffect(() => {
    if (!playing) return;

    if (phase === "transit") {
      // Still moving — wait for the next mapBusy flip.
      if (mapBusy) return;
      setPhase("interact");
      return;
    }

    // phase === "interact"
    const dur = Math.min(
      MAX_INTERACT_MS,
      BASE_INTERACT_MS + interactionCount * PER_EVENT_MS,
    );
    const t = window.setTimeout(() => {
      let nextDay = dayRef.current;
      let nextHour = hourRef.current + 1;
      if (nextHour > 23) {
        nextHour = 0;
        nextDay += 1;
      }
      if (nextDay > maxDay) {
        setPlaying(false);
        return;
      }
      onChange(nextDay, nextHour);
      setPhase("transit");
    }, dur / speed);
    return () => window.clearTimeout(t);
  }, [playing, phase, mapBusy, speed, interactionCount, maxDay, onChange]);

  // When the user scrubs the slider manually, reset to transit so the
  // state machine doesn't try to interact with stale state.
  const lastDayHourRef = useRef({ day, hour });
  useEffect(() => {
    const last = lastDayHourRef.current;
    if (last.day !== day || last.hour !== hour) {
      lastDayHourRef.current = { day, hour };
      if (phase !== "transit") setPhase("transit");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, hour]);

  return (
    <div className="playback">
      <button
        onClick={() => {
          if (atEnd) {
            onChange(1, 0);
            setPhase("transit");
            setPlaying(true);
          } else {
            setPlaying((p) => !p);
          }
        }}
        title={playing ? "pause" : atEnd ? "rewind & play" : "play"}
      >
        {playing ? "❚❚" : atEnd ? "↺ ▶" : "▶"}
      </button>
      <div
        className="playback-phase muted"
        title={
          playing
            ? phase === "transit"
              ? mapBusy
                ? "actors in transit…"
                : "preparing arrivals…"
              : "interactions playing out…"
            : "paused"
        }
      >
        {playing
          ? phase === "transit"
            ? mapBusy
              ? "🚶 transit"
              : "·"
            : "💬 interact"
          : ""}
      </div>
      <div className="playback-speeds">
        {SPEEDS.map((s, i) => (
          <button
            key={s.label}
            className={`speed ${speedIdx === i ? "speed-active" : ""}`}
            onClick={() => setSpeedIdx(i)}
            title={`${s.label} speed`}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function countInteractions(dump: RunDump, day: number, hour: number): number {
  let n = 0;
  for (const e of dump.events) {
    if (e.at.day !== day) continue;
    if (e.at.hour < hour) continue;
    if (e.at.hour > hour) break;
    if (e.type === "actor.departed" || e.type === "actor.travelled") continue;
    if (e.type === "day.started" || e.type === "day.ended") continue;
    n += 1;
  }
  return n;
}
