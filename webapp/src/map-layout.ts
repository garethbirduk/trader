import { useEffect, useState } from "react";

export interface MapLayout {
  /** Nodes that represent real trading locations. */
  locations: Record<string, { x: number; y: number }>;
  /** Pure routing nodes — corners, junctions; never appear in the
   *  actor diary. */
  waypoints: Record<string, { x: number; y: number }>;
  /** Undirected edges between any two node ids (location or waypoint). */
  edges: Array<readonly [string, string]>;
  /** Locations marked as "off map" / out of town. The graph still
   *  routes to/from them via their world position, but visually
   *  they always cluster on the canvas perimeter (independent of
   *  zoom/pan), and avatars at these locations cluster there too. */
  offMap: Record<string, true>;
}

/**
 * Default factory layout — the hand-tuned positions and edges shipped
 * with the app. The editor starts from this baseline (or from a user's
 * saved override stored in localStorage).
 */
export const DEFAULT_LAYOUT: MapLayout = {
  locations: {
    "lambeth-council-yard": { x: 110, y: 180 },
    "trigger-flat": { x: 430, y: 110 },
    "albert-legion": { x: 600, y: 220 },
    "auction-house": { x: 820, y: 200 },
    "one-eleven-club": { x: 1000, y: 130 },
    "starlight-rooms": { x: 1180, y: 200 },
    "off-map": { x: 1480, y: 90 },
    "raquel-flat": { x: 410, y: 310 },
    "mickey-jevon-flat": { x: 250, y: 400 },
    nags: { x: 560, y: 380 },
    "sids-cafe": { x: 640, y: 510 },
    "peckham-flat": { x: 800, y: 470 },
    "peckham-market": { x: 880, y: 580 },
    lockup: { x: 1010, y: 470 },
    "post-office": { x: 410, y: 540 },
    "betting-shop": { x: 540, y: 630 },
    "dirty-barrys": { x: 770, y: 660 },
    "police-station": { x: 620, y: 760 },
    "slater-flat": { x: 470, y: 830 },
    "boyce-auto-sales": { x: 380, y: 920 },
    "boycie-house": { x: 220, y: 850 },
    "parry-printers": { x: 1280, y: 270 },
    "parry-house": { x: 1450, y: 340 },
    "cassandra-bank": { x: 1180, y: 350 },
    "cassandra-flat": { x: 1130, y: 480 },
    "transworld-depot": { x: 1330, y: 700 },
    "denzil-house": { x: 1480, y: 860 },
    "shamrock-club": { x: 1330, y: 990 },
    "riverside-club": { x: 1180, y: 990 },
  },
  waypoints: {
    wp_NW: { x: 280, y: 290 },
    wp_N: { x: 700, y: 290 },
    wp_WS: { x: 290, y: 690 },
    wp_S: { x: 580, y: 870 },
    wp_E: { x: 1110, y: 470 },
    wp_SE: { x: 1180, y: 720 },
  },
  edges: [
    ["lambeth-council-yard", "wp_NW"],
    ["trigger-flat", "wp_NW"],
    ["raquel-flat", "wp_NW"],
    ["mickey-jevon-flat", "wp_NW"],
    ["trigger-flat", "wp_N"],
    ["albert-legion", "wp_N"],
    ["nags", "wp_N"],
    ["albert-legion", "auction-house"],
    ["auction-house", "one-eleven-club"],
    ["one-eleven-club", "starlight-rooms"],
    ["starlight-rooms", "off-map"],
    ["nags", "raquel-flat"],
    ["nags", "sids-cafe"],
    ["nags", "peckham-flat"],
    ["mickey-jevon-flat", "post-office"],
    ["peckham-flat", "sids-cafe"],
    ["peckham-flat", "peckham-market"],
    ["peckham-flat", "lockup"],
    ["peckham-flat", "post-office"],
    ["peckham-flat", "dirty-barrys"],
    ["sids-cafe", "post-office"],
    ["peckham-market", "lockup"],
    ["peckham-market", "auction-house"],
    ["peckham-market", "dirty-barrys"],
    ["post-office", "betting-shop"],
    ["betting-shop", "dirty-barrys"],
    ["betting-shop", "police-station"],
    ["dirty-barrys", "police-station"],
    ["police-station", "wp_S"],
    ["slater-flat", "wp_S"],
    ["boyce-auto-sales", "boycie-house"],
    ["boyce-auto-sales", "wp_S"],
    ["boycie-house", "wp_WS"],
    ["wp_WS", "post-office"],
    ["wp_WS", "mickey-jevon-flat"],
    ["lockup", "wp_E"],
    ["wp_E", "cassandra-flat"],
    ["wp_E", "cassandra-bank"],
    ["cassandra-flat", "cassandra-bank"],
    ["cassandra-bank", "parry-printers"],
    ["cassandra-bank", "parry-house"],
    ["parry-printers", "parry-house"],
    ["parry-printers", "auction-house"],
    ["wp_E", "wp_SE"],
    ["cassandra-flat", "wp_SE"],
    ["wp_SE", "transworld-depot"],
    ["transworld-depot", "denzil-house"],
    ["transworld-depot", "shamrock-club"],
    ["shamrock-club", "off-map"],
    ["riverside-club", "shamrock-club"],
  ],
  offMap: {
    "off-map": true,
  },
};

// The layout is served from /map.json (webapp/public/map.json) — that
// file is the single source of truth, version-controlled in the repo.
// In dev, Save POSTs back to /__map (handled by a Vite middleware) which
// rewrites the JSON file directly. DEFAULT_LAYOUT is kept only as a
// fallback for the brief window before the fetch resolves, or if the
// file is missing.

const LAYOUT_URL = `${import.meta.env.BASE_URL}map.json`;
const SAVE_URL = "/__map";

let _layout: MapLayout = DEFAULT_LAYOUT;
const subscribers = new Set<() => void>();

void (async () => {
  try {
    const res = await fetch(LAYOUT_URL, { cache: "no-store" });
    if (!res.ok) return;
    const parsed = (await res.json()) as Partial<MapLayout>;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      parsed.locations !== undefined &&
      parsed.waypoints !== undefined &&
      Array.isArray(parsed.edges)
    ) {
      _layout = {
        locations: parsed.locations,
        waypoints: parsed.waypoints,
        edges: parsed.edges,
        offMap: parsed.offMap ?? { ...DEFAULT_LAYOUT.offMap },
      };
      for (const cb of subscribers) cb();
    }
  } catch {
    /* keep DEFAULT_LAYOUT */
  }
})();

export function getLayout(): MapLayout {
  return _layout;
}

/**
 * Persist a new layout to webapp/public/map.json via the dev-only
 * Vite middleware, then notify every subscriber so map views re-render.
 * Throws if the write fails (e.g. running against a production build).
 */
export async function saveLayout(layout: MapLayout): Promise<void> {
  const res = await fetch(SAVE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(layout),
  });
  if (!res.ok) throw new Error(`saveLayout failed: ${res.status}`);
  _layout = layout;
  for (const cb of subscribers) cb();
}

/** Overwrite map.json with the in-code DEFAULT_LAYOUT. */
export async function resetLayout(): Promise<void> {
  await saveLayout(DEFAULT_LAYOUT);
}

/** React hook returning the current live layout. Re-renders the
 *  consuming component whenever `saveLayout` or `resetLayout` fires. */
export function useLayout(): MapLayout {
  const [, bump] = useState(0);
  useEffect(() => {
    const cb = () => bump((n) => (n + 1) & 0x7fffffff);
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  }, []);
  return _layout;
}

export function combinedPositions(
  layout: MapLayout,
): Record<string, { x: number; y: number }> {
  return { ...layout.locations, ...layout.waypoints };
}
