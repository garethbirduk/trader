import { dayLabel, isWeekend } from "../lib/calendar.js";

interface Props {
  readonly day: number;
  readonly hour: number;
  readonly maxDay: number;
  readonly onChange: (day: number, hour: number) => void;
}

const HOURS_PER_DAY = 24;

function toMinute(day: number, hour: number): number {
  return (day - 1) * HOURS_PER_DAY + hour;
}

function fromMinute(m: number): { day: number; hour: number } {
  const day = Math.floor(m / HOURS_PER_DAY) + 1;
  const hour = m - (day - 1) * HOURS_PER_DAY;
  return { day, hour };
}

export function TimeStepper({ day, hour, maxDay, onChange }: Props) {
  const total = maxDay * HOURS_PER_DAY - 1;
  const m = toMinute(day, hour);
  const clamp = (v: number) => Math.max(0, Math.min(total, v));
  const step = (delta: number) => {
    const next = fromMinute(clamp(m + delta));
    onChange(next.day, next.hour);
  };
  return (
    <div className="stepper">
      <button onClick={() => step(-1)} disabled={m <= 0} title="−1 hour">‹‹</button>
      <button onClick={() => step(-24)} disabled={m < 24} title="−1 day">‹day</button>
      <input
        type="range"
        min={0}
        max={total}
        value={m}
        onChange={(e) => {
          const next = fromMinute(Number(e.target.value));
          onChange(next.day, next.hour);
        }}
      />
      <span className={`day-label ${isWeekend(day) ? "is-weekend" : ""}`}>
        {dayLabel(day)} · {String(hour).padStart(2, "0")}:00
      </span>
      <button onClick={() => step(24)} disabled={m + 24 > total} title="+1 day">day›</button>
      <button onClick={() => step(1)} disabled={m >= total} title="+1 hour">››</button>
    </div>
  );
}
