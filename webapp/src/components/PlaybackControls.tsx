import { useEffect, useRef, useState } from "react";

interface Props {
  readonly day: number;
  readonly hour: number;
  readonly maxDay: number;
  readonly onChange: (day: number, hour: number) => void;
}

const SPEEDS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: "0.5×", ms: 800 },
  { label: "1×", ms: 400 },
  { label: "2×", ms: 200 },
  { label: "4×", ms: 100 },
];

export function PlaybackControls({ day, hour, maxDay, onChange }: Props) {
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(1);
  const dayRef = useRef(day);
  const hourRef = useRef(hour);
  dayRef.current = day;
  hourRef.current = hour;

  const atEnd = day >= maxDay && hour >= 23;

  useEffect(() => {
    if (!playing) return;
    const interval = window.setInterval(() => {
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
    }, SPEEDS[speedIdx]!.ms);
    return () => window.clearInterval(interval);
  }, [playing, speedIdx, maxDay, onChange]);

  return (
    <div className="playback">
      <button
        onClick={() => {
          if (atEnd) {
            onChange(1, 0);
            setPlaying(true);
          } else {
            setPlaying((p) => !p);
          }
        }}
        title={playing ? "pause" : atEnd ? "rewind & play" : "play"}
      >
        {playing ? "❚❚" : atEnd ? "↺ ▶" : "▶"}
      </button>
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
