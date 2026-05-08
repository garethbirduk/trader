import { useEffect, useState } from "react";

/**
 * Tiny shared signal for cross-component playback coordination.
 *
 *   - `mapBusy`: true while any avatar is mid-animation. Set every
 *     frame by MapGraph's rAF loop. PlaybackControls reads it to
 *     hold the playback timer until everyone has finished their
 *     leave→arrive walk.
 *   - `speed`: playback speed multiplier (0.5 / 1 / 2 / 4 ×). Scales
 *     both the avatar walk speed and the per-hour interaction-pause
 *     duration so the visual phase ordering holds at any speed.
 */
let _mapBusy = false;
let _speed = 1;
const subscribers = new Set<() => void>();

export function setMapBusy(busy: boolean): void {
  if (_mapBusy === busy) return;
  _mapBusy = busy;
  for (const cb of subscribers) cb();
}

export function getMapBusy(): boolean {
  return _mapBusy;
}

export function setPlaybackSpeed(speed: number): void {
  if (_speed === speed) return;
  _speed = speed;
  for (const cb of subscribers) cb();
}

export function getPlaybackSpeed(): number {
  return _speed;
}

export function useMapBusy(): boolean {
  const [, bump] = useState(0);
  useEffect(() => {
    const cb = () => bump((n) => (n + 1) & 0x7fffffff);
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  }, []);
  return _mapBusy;
}
