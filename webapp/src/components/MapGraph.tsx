import { useEffect, useMemo, useRef, useState } from "react";
import type { DaySnapshot, RunDump, RunEvent } from "../types.js";
import type { Selection } from "../App.js";
import { getActorColor, getInitials, getLocationColor } from "../avatar.js";
import { LocationAvatar } from "./LocationAvatar.js";
import { combinedPositions, useLayout, type MapLayout } from "../map-layout.js";
import { getPlaybackSpeed, setMapBusy } from "../anim-state.js";
import { isHourInAuctionWindow } from "../lib/auction-window.js";
import {
  MapBasemap,
  NodeLabel,
  WORLD_W,
  WORLD_H,
  NODE_R,
} from "./map-shared.js";
import { dayLabel } from "../lib/calendar.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly hour: number;
  readonly snapshot: DaySnapshot | null;
  readonly selection: Selection | null;
  readonly onSelect: (s: Selection | null) => void;
}

// Layout (positions + edges) lives in map-layout.ts so the editor and
// the runtime view share one source of truth. We mirror the latest
// values into module-level vars at the top of each render so the
// existing module-level helpers keep working without threading a
// layout argument through every call site.
let LOCATION_POSITIONS: Record<string, { x: number; y: number }> = {};
let WAYPOINT_POSITIONS: Record<string, { x: number; y: number }> = {};
let POSITIONS: Record<string, { x: number; y: number }> = {};
let EDGES: ReadonlyArray<readonly [string, string]> = [];

function syncFromLayout(layout: MapLayout): void {
  LOCATION_POSITIONS = layout.locations;
  WAYPOINT_POSITIONS = layout.waypoints;
  POSITIONS = combinedPositions(layout);
  EDGES = layout.edges;
}

const SHORT_LABELS: Record<string, string> = {
  "peckham-flat": "Del's",
  "boycie-house": "Boycie's",
  "denzil-house": "Denzil's",
  "boyce-auto-sales": "Boyce Autos",
  "transworld-depot": "Transworld",
  "lambeth-council-yard": "Council yard",
  "auction-house": "Sotheby's",
  "one-eleven-club": "111 Club",
  "starlight-rooms": "Starlight",
  "mickey-jevon-flat": "Mickey/Jevon",
  "cassandra-flat": "Cassandra's",
  "parry-house": "Parry's",
  "trigger-flat": "Trigger's",
  "raquel-flat": "Raquel's",
  "slater-flat": "Slater's",
  "albert-legion": "Br. Legion",
  "shamrock-club": "Shamrock",
  "police-station": "Police",
  "parry-printers": "Parry Print",
  "cassandra-bank": "Bank",
  "post-office": "Post Office",
  "betting-shop": "Bookies",
  "dirty-barrys": "Dirty Barry's",
  "sids-cafe": "Sid's",
  "peckham-market": "Market",
};

// Edges live in map-layout.ts (defaults + saved overrides).
// Location node fill colours are now derived from `getLocationColor()`
// in ../avatar.ts so the on-map node and the chip-style LocationRef
// stay in sync.
const HEX_PLAYER = "#ffb84d";
const AVATAR_R = 13;
/** Side length (px in SVG world units) of a location's square node
 *  avatar. Roughly matches the diameter of an actor's circle so the two
 *  read as equal-weight first-class entities on the map. */
const LOC_NODE_SIZE = 22;

interface Adjacency {
  readonly graph: Map<string, ReadonlyArray<{ to: string; cost: number }>>;
}

function buildAdjacency(): Adjacency {
  const g = new Map<string, Array<{ to: string; cost: number }>>();
  const link = (a: string, b: string) => {
    const pa = POSITIONS[a];
    const pb = POSITIONS[b];
    if (!pa || !pb) return;
    const cost = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    if (!g.has(a)) g.set(a, []);
    if (!g.has(b)) g.set(b, []);
    g.get(a)!.push({ to: b, cost });
    g.get(b)!.push({ to: a, cost });
  };
  for (const [a, b] of EDGES) link(a, b);
  return { graph: g };
}

/**
 * Dijkstra over the location graph. Returns the sequence of location
 * codes from `start` to `goal` inclusive (or [] if no path).
 */
function shortestPath(adj: Adjacency, start: string, goal: string): string[] {
  if (start === goal) return [start];
  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const visited = new Set<string>();
  const queue = new Set<string>(adj.graph.keys());
  for (const k of adj.graph.keys()) dist.set(k, Infinity);
  dist.set(start, 0);

  while (queue.size > 0) {
    let u: string | null = null;
    let best = Infinity;
    for (const node of queue) {
      const d = dist.get(node) ?? Infinity;
      if (d < best) { best = d; u = node; }
    }
    if (u === null || best === Infinity) break;
    queue.delete(u);
    visited.add(u);
    if (u === goal) break;
    for (const edge of adj.graph.get(u) ?? []) {
      if (visited.has(edge.to)) continue;
      const alt = best + edge.cost;
      if (alt < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, alt);
        prev.set(edge.to, u);
      }
    }
  }

  if (!prev.has(goal) && start !== goal) return [];
  const path: string[] = [];
  let cur: string | undefined = goal;
  while (cur !== undefined) {
    path.unshift(cur);
    if (cur === start) return path;
    cur = prev.get(cur);
  }
  return [];
}

interface PathInfo {
  readonly nodes: readonly string[];
  readonly cumulativeLength: readonly number[];
  readonly totalLength: number;
}

function pathInfo(path: readonly string[]): PathInfo {
  const cum: number[] = [0];
  for (let i = 1; i < path.length; i += 1) {
    const a = POSITIONS[path[i - 1]!]!;
    const b = POSITIONS[path[i]!]!;
    cum.push((cum[i - 1] ?? 0) + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return { nodes: path, cumulativeLength: cum, totalLength: cum[cum.length - 1] ?? 0 };
}

function pointAtDistance(info: PathInfo, dist: number): { x: number; y: number } {
  const { nodes, cumulativeLength, totalLength } = info;
  if (nodes.length === 0) return { x: 0, y: 0 };
  if (dist <= 0) return POSITIONS[nodes[0]!]!;
  if (dist >= totalLength) return POSITIONS[nodes[nodes.length - 1]!]!;
  for (let i = 1; i < nodes.length; i += 1) {
    const a = cumulativeLength[i - 1]!;
    const b = cumulativeLength[i]!;
    if (b >= dist) {
      const t = b - a > 0 ? (dist - a) / (b - a) : 0;
      const p0 = POSITIONS[nodes[i - 1]!]!;
      const p1 = POSITIONS[nodes[i]!]!;
      return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
    }
  }
  return POSITIONS[nodes[nodes.length - 1]!]!;
}

interface ViewState {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const DEFAULT_VIEW: ViewState = { x: 0, y: 0, w: WORLD_W, h: WORLD_H };

interface ActorAnim {
  x: number;
  y: number;
  /** Polyline to walk; first point is the position they started at. */
  path: ReadonlyArray<{ x: number; y: number }>;
  /** Cumulative arc length per polyline point. */
  lengthAt: ReadonlyArray<number>;
  /** Current arc length along the path. */
  progress: number;
  /** Stop the walk here (so transit halts at the path midpoint). */
  targetProgress: number;
  transit: boolean;
  /** Graph nodes the avatar is walking through, in order. Used to
   *  pick a sensible "start node" when re-routing mid-edge so the
   *  new path doesn't double back. */
  nodes: ReadonlyArray<string>;
  /** Arc length at which each entry of `nodes` is reached along the
   *  polyline (parallel to `nodes`). */
  nodeLengthAt: ReadonlyArray<number>;
}

const ANIM_SPEED_PX_PER_SEC = 700;

export function MapGraph(props: Props) {
  const { dump, day, hour, selection, onSelect } = props;
  const layout = useLayout();
  syncFromLayout(layout);
  const adj = useMemo(buildAdjacency, [layout]);
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number }>({
    w: WORLD_W,
    h: WORLD_H,
  });
  const [view, setView] = useState<ViewState>(DEFAULT_VIEW);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(
    null,
  );
  // Per-actor manual animation state. Avatar walks along its `path`
  // each frame instead of cutting straight via CSS.
  const animsRef = useRef<Map<number, ActorAnim>>(new Map());
  // Frame counter: bumped each tick that any actor is still moving, so
  // React re-renders the avatar transforms.
  const [, setFrame] = useState(0);

  // Resolve location code → id and id → code.
  const codeById = useMemo(() => {
    const m = new Map<number, string>();
    for (const l of dump.locations) m.set(l.id, l.code);
    return m;
  }, [dump.locations]);

  // Compute each actor's current placement: at a location or in transit.
  const placement = useMemo(() => {
    const startSnap =
      dump.snapshots?.find((s) => s.day === day - 1) ??
      dump.snapshots?.find((s) => s.day === day) ?? null;
    const before = new Map<number, number | null>();
    if (startSnap !== null)
      for (const a of startSnap.actors) before.set(a.id, a.currentLocationId);
    for (const e of dump.events as readonly RunEvent[]) {
      if (e.at.day !== day) continue;
      if (e.at.hour >= hour) break;
      if (e.type !== "actor.travelled") continue;
      before.set(e.actorId as number, (e.toLocationId as number) ?? null);
    }
    const at = new Map<number, number | null>(before);
    for (const e of dump.events as readonly RunEvent[]) {
      if (e.at.day !== day) continue;
      if (e.at.hour > hour) break;
      if (e.at.hour < hour) continue;
      if (e.type !== "actor.travelled") continue;
      at.set(e.actorId as number, (e.toLocationId as number) ?? null);
    }
    const result = new Map<
      number,
      | { kind: "at"; locationCode: string }
      | { kind: "transit"; pathInfo: PathInfo }
    >();
    for (const a of dump.actors) {
      const bf = before.has(a.id) ? before.get(a.id) ?? null : a.currentLocationId;
      const af = at.has(a.id) ? at.get(a.id) ?? null : a.currentLocationId;
      if (bf !== null && af !== null && bf !== af) {
        const ca = codeById.get(bf);
        const cb = codeById.get(af);
        if (ca && cb && POSITIONS[ca] && POSITIONS[cb]) {
          const path = shortestPath(adj, ca, cb);
          if (path.length >= 2) {
            result.set(a.id, { kind: "transit", pathInfo: pathInfo(path) });
            continue;
          }
        }
      }
      if (af !== null) {
        const code = codeById.get(af);
        if (code !== undefined && POSITIONS[code]) {
          result.set(a.id, { kind: "at", locationCode: code });
        }
      }
    }
    return result;
  }, [dump, day, hour, adj, codeById]);

  // Stack actors at the same location so multiple-here don't overlap.
  // Includes transit actors whose destination is this location — by the
  // end of an arrival hour they're conceptually at the destination, so
  // they should get an orbit slot rather than render on top of the
  // location's own avatar.
  const stackedAt = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const [aid, p] of placement) {
      let code: string | null = null;
      if (p.kind === "at") {
        code = p.locationCode;
      } else {
        const nodes = p.pathInfo.nodes;
        const last = nodes[nodes.length - 1];
        if (last !== undefined) code = last;
      }
      if (code === null) continue;
      const list = m.get(code) ?? [];
      list.push(aid);
      m.set(code, list);
    }
    return m;
  }, [placement]);

  // Per-in-transit-actor route overlays are computed inline at render
  // time (not via useMemo) so the polyline shrinks every frame as the
  // avatar consumes their route. The slice runs from the avatar's
  // current arc-length progress to their targetProgress, so what's
  // drawn is always "the bit ahead of them, in their colour".

  // Where each actor "wants to be" right now (end-of-current-hour).
  // The polyline target is **always a graph node centre** — never an
  // offset position — so the walk stays exactly on the road. Stack
  // jitter (so co-located actors don't perfectly overlap) is computed
  // separately as a `renderOffset` and applied via CSS transition at
  // render time, only when the avatar is at-location and idle.
  const targets = useMemo(() => {
    const map = new Map<
      number,
      {
        x: number;
        y: number;
        transit: boolean;
        nodes: readonly string[];
        targetFraction: number;
      }
    >();
    for (const a of dump.actors) {
      const p = placement.get(a.id);
      if (!p) continue;
      if (p.kind === "at") {
        const pos = LOCATION_POSITIONS[p.locationCode];
        if (!pos) continue;
        map.set(a.id, {
          x: pos.x,
          y: pos.y,
          transit: false,
          nodes: [p.locationCode],
          targetFraction: 1,
        });
      } else {
        // Transit: walk the FULL path so the avatar reaches the
        // destination within the hour (matches the engine, where
        // travel is "1 hour for any distance" and the actor has
        // arrived by end of H). The route overlay still shrinks as
        // they walk, so the journey is visible.
        const lastCode = p.pathInfo.nodes[p.pathInfo.nodes.length - 1];
        const destPos =
          lastCode !== undefined ? LOCATION_POSITIONS[lastCode] : undefined;
        if (destPos === undefined) continue;
        map.set(a.id, {
          x: destPos.x,
          y: destPos.y,
          transit: true,
          nodes: p.pathInfo.nodes,
          targetFraction: 1,
        });
      }
    }
    return map;
  }, [dump.actors, placement]);

  // Stack-jitter render offsets: applied on top of the on-road anim
  // position via a CSS-transitioned inner <g>. Transit avatars get the
  // same orbital offset as their at-location peers so that at the
  // moment of arrival (end-of-hour static state) they sit on the orbit
  // ring rather than on top of the destination's avatar. The aesthetic
  // cost is that during transit animation playback the avatar walks
  // parallel to the polyline rather than exactly on it.
  const renderOffsets = useMemo(() => {
    const map = new Map<number, { x: number; y: number }>();
    for (const a of dump.actors) {
      const p = placement.get(a.id);
      if (!p) {
        map.set(a.id, { x: 0, y: 0 });
        continue;
      }
      const code =
        p.kind === "at"
          ? p.locationCode
          : (p.pathInfo.nodes[p.pathInfo.nodes.length - 1] ?? null);
      if (code === null) {
        map.set(a.id, { x: 0, y: 0 });
        continue;
      }
      const list = stackedAt.get(code) ?? [];
      const idx = list.indexOf(a.id);
      const total = Math.max(1, list.length);
      // Orbit every at-location actor, including a solo one — the
      // location's own square avatar sits at the node centre, so
      // overlaying actors there would obscure the place itself.
      // First actor sits at the top (-π/2); additional actors fan
      // out clockwise. The brief 320 ms CSS-transition slide from
      // this orbit point to (0,0) at the start of a transit is
      // accepted as visual cost.
      const angle = (idx / total) * Math.PI * 2 - Math.PI / 2;
      const r = NODE_R + AVATAR_R + 6;
      map.set(a.id, {
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r,
      });
    }
    return map;
  }, [dump.actors, placement, stackedAt]);

  // Whenever targets change, build each actor's animation polyline and
  // reset progress to 0. The path is the shortest-path polyline from
  // wherever the avatar currently is to wherever they're heading,
  // including the offset from the node centre (stack jitter or transit
  // midpoint).
  useEffect(() => {
    let anyMoving = false;
    for (const a of dump.actors) {
      const target = targets.get(a.id);
      if (!target) continue;
      const existing = animsRef.current.get(a.id);
      if (!existing) {
        // First time: snap to target.
        animsRef.current.set(a.id, {
          x: target.x,
          y: target.y,
          path: [{ x: target.x, y: target.y }],
          lengthAt: [0],
          progress: 0,
          targetProgress: 0,
          transit: target.transit,
          nodes: [],
          nodeLengthAt: [],
        });
        continue;
      }
      // If they're already there, just update transit flag.
      const distSq =
        (existing.x - target.x) ** 2 + (existing.y - target.y) ** 2;
      if (distSq < 0.25) {
        existing.transit = target.transit;
        continue;
      }
      // pickStartNode (inside buildAnimPath) needs the previous
      // animation state to know which two graph nodes bracket the
      // avatar's current position — those are the only valid entry
      // points back into the network for the new route.
      const built = buildAnimPath(
        { x: existing.x, y: existing.y },
        target,
        adj,
        existing,
      );
      existing.path = built.path;
      existing.lengthAt = built.lengthAt;
      existing.nodes = built.nodes;
      existing.nodeLengthAt = built.nodeLengthAt;
      existing.progress = 0;
      // For transit, this is total × 0.5 so the avatar stops at the
      // path midpoint *along the road*; for at-location it's total
      // (full walk).
      existing.targetProgress = built.targetProgress;
      existing.transit = target.transit;
      if (existing.targetProgress > 0) anyMoving = true;
    }
    // Tell the playback timer "we're now transiting". The rAF loop
    // will keep it true and flip it false when everyone's settled.
    if (anyMoving) setMapBusy(true);
  }, [targets, adj, dump.actors]);

  // Single rAF loop driving every active animation. Publishes a
  // global `mapBusy` flag (via anim-state) so PlaybackControls can
  // hold the playback timer until every avatar has finished its
  // leave→arrive walk.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastBusy = false;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const speed = getPlaybackSpeed();
      let anyActive = false;
      for (const anim of animsRef.current.values()) {
        if (anim.progress < anim.targetProgress) {
          anim.progress = Math.min(
            anim.targetProgress,
            anim.progress + ANIM_SPEED_PX_PER_SEC * speed * dt,
          );
          const p = pointAlongPolyline(
            anim.path,
            anim.lengthAt,
            anim.progress,
          );
          anim.x = p.x;
          anim.y = p.y;
          anyActive = true;
        }
      }
      if (anyActive !== lastBusy) {
        lastBusy = anyActive;
        setMapBusy(anyActive);
      }
      if (anyActive) setFrame((n) => (n + 1) & 0x7fffffff);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      setMapBusy(false);
    };
  }, []);

  // Pan via drag.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      // Only pan when starting outside any interactive element. Buttons
      // / nodes have stopPropagation handlers on click.
      const target = e.target as Element;
      if (target.closest("[data-clickable]")) return;
      dragRef.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
      svg.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const rect = svg.getBoundingClientRect();
      const scaleX = view.w / rect.width;
      const scaleY = view.h / rect.height;
      const dx = (e.clientX - drag.x) * scaleX;
      const dy = (e.clientY - drag.y) * scaleY;
      setView((v) => ({ ...v, x: drag.vx - dx, y: drag.vy - dy }));
    };
    const onPointerUp = (e: PointerEvent) => {
      if (dragRef.current !== null) {
        dragRef.current = null;
        try { svg.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      }
    };
    svg.addEventListener("pointerdown", onPointerDown);
    svg.addEventListener("pointermove", onPointerMove);
    svg.addEventListener("pointerup", onPointerUp);
    svg.addEventListener("pointercancel", onPointerUp);
    return () => {
      svg.removeEventListener("pointerdown", onPointerDown);
      svg.removeEventListener("pointermove", onPointerMove);
      svg.removeEventListener("pointerup", onPointerUp);
      svg.removeEventListener("pointercancel", onPointerUp);
    };
  }, [view.x, view.y, view.w, view.h]);

  // Track the SVG canvas's actual pixel size so we can clamp the
  // off-screen indicators to the real visible-canvas edges (instead
  // of the viewBox edges, which sit inside letterbox bars when the
  // canvas aspect doesn't match the world aspect).
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const ro = new ResizeObserver(() => {
      const r = svg.getBoundingClientRect();
      setCanvasSize({ w: r.width, h: r.height });
    });
    ro.observe(svg);
    const r = svg.getBoundingClientRect();
    setCanvasSize({ w: r.width, h: r.height });
    return () => ro.disconnect();
  }, []);

  // Wheel zoom (cursor-pivoted).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) => {
        const factor = e.deltaY > 0 ? 1.18 : 1 / 1.18;
        const newW = Math.max(WORLD_W * 0.2, Math.min(WORLD_W * 1.4, v.w * factor));
        const newH = newW * (WORLD_H / WORLD_W);
        if (newW === v.w) return v;
        const rect = svg.getBoundingClientRect();
        const mx = ((e.clientX - rect.left) / rect.width) * v.w + v.x;
        const my = ((e.clientY - rect.top) / rect.height) * v.h + v.y;
        // Keep cursor on same world point.
        const newX = mx - ((e.clientX - rect.left) / rect.width) * newW;
        const newY = my - ((e.clientY - rect.top) / rect.height) * newH;
        return { x: newX, y: newY, w: newW, h: newH };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  const selLoc = selection?.kind === "location" ? selection.id : null;
  const selActor = selection?.kind === "actor" ? selection.id : null;

  return (
    <div className="map-view">
      <svg
        ref={svgRef}
        className="graph-map"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <MapBasemap />
        {/* Base edges — always plain grey. */}
        <g className="edges">
          {EDGES.map(([a, b]) => {
            const pa = POSITIONS[a];
            const pb = POSITIONS[b];
            if (!pa || !pb) return null;
            return (
              <line
                key={edgeKey(a, b)}
                x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
                className="graph-edge"
              />
            );
          })}
        </g>
        {/* Per-actor route overlays for in-transit actors. The route
            shrinks each frame as the avatar walks along it (slice
            from anim.progress to anim.targetProgress), so by the
            time they reach the target the line has fully cleaned
            up. Makes routing bugs obvious — if the line lingers
            behind the avatar, something's wrong. */}
        <g className="route-overlays" pointerEvents="none">
          {dump.actors.map((actor) => {
            const anim = animsRef.current.get(actor.id);
            if (!anim || !anim.transit) return null;
            if (anim.progress >= anim.targetProgress - 0.5) return null;
            const remaining = sliceProgress(
              anim.path,
              anim.lengthAt,
              anim.progress,
              anim.targetProgress,
            );
            if (remaining.length < 2) return null;
            const isPlayer = actor.id === dump.playerActorId;
            const colour = getActorColor({
              code: actor.code,
              isPlayer,
            });
            return (
              <polyline
                key={`route-${actor.id}`}
                points={remaining
                  .map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
                  .join(" ")}
                fill="none"
                stroke={colour}
                strokeWidth={2.8}
                strokeLinecap="round"
                strokeDasharray="6 5"
                opacity={0.75}
                className="route-overlay"
              />
            );
          })}
        </g>

        {/* Waypoint nodes — drawn first so location labels sit on top */}
        <g className="waypoints">
          {Object.entries(WAYPOINT_POSITIONS).map(([id, pos]) => (
            <circle
              key={id}
              cx={pos.x}
              cy={pos.y}
              r={3.5}
              className="graph-waypoint"
            />
          ))}
        </g>

        {/* Location nodes — off-map locations skip the SVG render
            and appear as perimeter markers in the HTML overlay
            below, so they always sit on the canvas edge regardless
            of zoom/pan. */}
        <g className="nodes">
          {dump.locations.map((loc) => {
            if (layout.offMap[loc.code] === true) return null;
            const pos = POSITIONS[loc.code];
            if (!pos) return null;
            const isSel = loc.id === selLoc;
            const isAuction =
              loc.id === dump.auctionLocationId ||
              (loc as { type?: string }).type === "auction";
            const isStar = isAuction && isHourInAuctionWindow(dump, hour);
            const t = (loc as { type?: string }).type ?? "business";
            const fill = getLocationColor({ code: loc.code, type: t });
            const stroke = isSel || isStar ? HEX_PLAYER : "rgba(0,0,0,0.4)";
            const strokeWidth = isSel || isStar ? 2.5 : 1;
            const label = (isStar ? "★ " : "") +
              (SHORT_LABELS[loc.code] ?? loc.displayName);
            const sq = LOC_NODE_SIZE;
            return (
              <g
                key={loc.id}
                transform={`translate(${pos.x}, ${pos.y})`}
                data-clickable
                style={{ cursor: "pointer" }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(isSel ? null : { kind: "location", id: loc.id });
                }}
              >
                <rect
                  x={-sq / 2}
                  y={-sq / 2}
                  width={sq}
                  height={sq}
                  rx={5}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                />
                <text
                  className="loc-node-initials"
                  textAnchor="middle"
                  dy="0.35em"
                  fontSize={Math.round(sq * 0.42)}
                  fontWeight={600}
                  fill="#0d0d12"
                  fontFamily="ui-monospace, Consolas, monospace"
                  style={{ pointerEvents: "none" }}
                >
                  {getInitials(loc.displayName)}
                </text>
                <NodeLabel text={label} yOffset={-sq / 2 - 14} />
              </g>
            );
          })}
        </g>

        {/* Avatars — outer <g> is the on-road walk position (anim.x/y
            tweened along the polyline). Inner <g> applies the
            stack-jitter offset with a CSS transition, so the avatar
            walks exactly on the road and only fans out once it has
            arrived at a location. */}
        <g className="avatars">
          {dump.actors.map((actor) => {
            const anim = animsRef.current.get(actor.id);
            if (!anim) return null;
            // Avatars currently AT an off-map location render in the
            // HTML overlay (clustered with the perimeter marker);
            // skip the SVG copy. Transit avatars still walk the
            // polyline as world coords here.
            if (!anim.transit) {
              const code = placement.get(actor.id);
              if (
                code &&
                code.kind === "at" &&
                layout.offMap[code.locationCode] === true
              ) {
                return null;
              }
            }
            const off = renderOffsets.get(actor.id) ?? { x: 0, y: 0 };
            const isPlayer = actor.id === dump.playerActorId;
            const isSel = actor.id === selActor;
            const colour = getActorColor({ code: actor.code, isPlayer });
            return (
              <g
                key={actor.id}
                transform={`translate(${anim.x}, ${anim.y})`}
                data-clickable
                style={{ cursor: "pointer" }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(isSel ? null : { kind: "actor", id: actor.id });
                }}
              >
                <g
                  style={{
                    transform: `translate(${off.x}px, ${off.y}px)`,
                  }}
                >
                  <circle
                    r={AVATAR_R}
                    fill={colour}
                    stroke={isSel ? "#fff" : isPlayer ? "#fff" : "rgba(0,0,0,0.5)"}
                    strokeWidth={isSel ? 2.5 : isPlayer ? 1.5 : 1}
                  />
                  <text
                    className="avatar-initials"
                    textAnchor="middle"
                    dy="0.35em"
                  >
                    {getInitials(actor.displayName)}
                  </text>
                  <title>
                    {actor.displayName}
                    {anim.transit ? " (in transit)" : ""}
                  </title>
                </g>
              </g>
            );
          })}
        </g>

      </svg>
      {/* Off-screen perimeter indicators + off-map markers, both
          rendered in *pixel* space. The overlay is sized to the SVG's
          bounding rect so positions track the actual canvas edge
          across resizes (no letterbox bars eating the perimeter). */}
      <div className="map-indicators-overlay">
        {/* Off-map location markers — clamped to canvas perimeter at
            the angle from canvas centre to the location's world
            position. They always sit on the edge, regardless of zoom. */}
        {dump.locations.map((loc) => {
          if (layout.offMap[loc.code] !== true) return null;
          const pos = POSITIONS[loc.code];
          if (!pos) return null;
          const peri = projectToPerimeter(pos.x, pos.y, view, canvasSize, 18);
          if (peri === null) return null;
          const isSel = loc.id === selLoc;
          const pop = stackedAt.get(loc.code)?.length ?? 0;
          return (
            <button
              key={`offmap-${loc.code}`}
              className={`map-offmap-marker ${isSel ? "selected" : ""}`}
              style={{ left: `${peri.x}px`, top: `${peri.y}px` }}
              title={`${loc.displayName} (off-map)${pop > 0 ? ` · ${pop}` : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(isSel ? null : { kind: "location", id: loc.id });
              }}
            >
              <LocationAvatar
                displayName={loc.displayName}
                code={loc.code}
                type={(loc as { type?: string }).type}
                size={14}
              />
              <span className="offmap-label">
                {SHORT_LABELS[loc.code] ?? loc.displayName}
              </span>
              {pop > 0 ? <span className="offmap-pop">{pop}</span> : null}
            </button>
          );
        })}
        {dump.actors.map((actor) => {
          const anim = animsRef.current.get(actor.id);
          if (!anim) return null;
          const off = renderOffsets.get(actor.id) ?? { x: 0, y: 0 };
          // If the actor is at-location at an off-map place, force a
          // perimeter render (clustered at the off-map marker), even
          // if their world position would otherwise fall inside the
          // canvas at the current zoom.
          let perim: { x: number; y: number } | null = null;
          let titleSuffix = " (off-screen)";
          if (!anim.transit) {
            const pl = placement.get(actor.id);
            if (
              pl &&
              pl.kind === "at" &&
              layout.offMap[pl.locationCode] === true
            ) {
              const pos = POSITIONS[pl.locationCode];
              if (pos) {
                perim = projectToPerimeter(pos.x, pos.y, view, canvasSize, 18);
                titleSuffix = " (off-map)";
              }
            }
          }
          if (perim === null) {
            const wx = anim.x + off.x;
            const wy = anim.y + off.y;
            const screen = worldToScreen(wx, wy, view, canvasSize);
            const margin = 18;
            const inside =
              screen.x >= margin &&
              screen.x <= canvasSize.w - margin &&
              screen.y >= margin &&
              screen.y <= canvasSize.h - margin;
            if (inside) return null;
            const cx = canvasSize.w / 2;
            const cy = canvasSize.h / 2;
            const dx = screen.x - cx;
            const dy = screen.y - cy;
            if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return null;
            let t = Infinity;
            if (dx > 0) t = Math.min(t, (canvasSize.w - margin - cx) / dx);
            else if (dx < 0) t = Math.min(t, (margin - cx) / dx);
            if (dy > 0) t = Math.min(t, (canvasSize.h - margin - cy) / dy);
            else if (dy < 0) t = Math.min(t, (margin - cy) / dy);
            if (!Number.isFinite(t) || t <= 0) return null;
            perim = { x: cx + dx * t, y: cy + dy * t };
          }
          const isPlayer = actor.id === dump.playerActorId;
          const isSel = actor.id === selActor;
          const colour = getActorColor({ code: actor.code, isPlayer });
          // Tiny stack offset so multiple avatars at the same
          // off-map location don't perfectly overlap.
          const stackOff = renderOffsets.get(actor.id) ?? { x: 0, y: 0 };
          const px = perim.x + stackOff.x * 0.35;
          const py = perim.y + stackOff.y * 0.35;
          return (
            <button
              key={`ind-${actor.id}`}
              className={`map-indicator ${isSel ? "selected" : ""}`}
              style={{
                left: `${px}px`,
                top: `${py}px`,
                background: colour,
              }}
              title={`${actor.displayName}${titleSuffix}`}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(isSel ? null : { kind: "actor", id: actor.id });
              }}
            >
              {getInitials(actor.displayName)}
            </button>
          );
        })}
      </div>
      <div className="map-legend muted">
        {dayLabel(day)} · {String(hour).padStart(2, "0")}:00 · scroll to zoom ·
        drag empty space to pan · routes path through intermediate nodes
      </div>
    </div>
  );
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Convert a world coordinate to canvas pixel coordinates given the
 * current viewBox and canvas size. Mirrors the transform that SVG
 * applies under `preserveAspectRatio="xMidYMid meet"`: viewBox is
 * fitted entirely inside the canvas with letterbox/pillarbox
 * padding centred on the wider axis.
 */
function worldToScreen(
  wx: number,
  wy: number,
  view: ViewState,
  canvas: { w: number; h: number },
): { x: number; y: number } {
  const scale = Math.min(canvas.w / view.w, canvas.h / view.h);
  const padX = (canvas.w - view.w * scale) / 2;
  const padY = (canvas.h - view.h * scale) / 2;
  return {
    x: (wx - view.x) * scale + padX,
    y: (wy - view.y) * scale + padY,
  };
}

/**
 * Force-project a world point to the canvas perimeter (with margin),
 * along the ray from the canvas centre to that point. Used for off-
 * map markers: even if the world point projects inside the visible
 * canvas at the current zoom, we still want the marker at the edge.
 */
function projectToPerimeter(
  wx: number,
  wy: number,
  view: ViewState,
  canvas: { w: number; h: number },
  margin: number,
): { x: number; y: number } | null {
  if (canvas.w <= margin * 2 || canvas.h <= margin * 2) return null;
  const screen = worldToScreen(wx, wy, view, canvas);
  const cx = canvas.w / 2;
  const cy = canvas.h / 2;
  const dx = screen.x - cx;
  const dy = screen.y - cy;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return null;
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (canvas.w - margin - cx) / dx);
  else if (dx < 0) t = Math.min(t, (margin - cx) / dx);
  if (dy > 0) t = Math.min(t, (canvas.h - margin - cy) / dy);
  else if (dy < 0) t = Math.min(t, (margin - cy) / dy);
  if (!Number.isFinite(t) || t <= 0) return null;
  return { x: cx + dx * t, y: cy + dy * t };
}

/**
 * Find the shortest-path polyline from a free-floating start point to
 * a target point, walking through real graph nodes wherever possible.
 *
 * If `nextNodeAhead` is supplied (mid-animation re-route), use it as
 * the route's first graph node instead of `nearestNode(start)` — this
 * keeps the avatar moving forward toward the next-node-it-was-heading-
 * to, rather than backtracking through the node it just left.
 *
 * The returned polyline is built strictly from graph node centres
 * (plus a leading point at the avatar's current position). The
 * "stopping point" for transit (mid-hour midpoint) is expressed by
 * `targetProgress` — the rAF loop walks until `progress` reaches it
 * and stops. Earlier versions appended the midpoint position as the
 * last polyline point, which made the path overshoot the destination
 * node and then backtrack to the midpoint.
 */
/**
 * Pick the cheapest start node for a re-route. The candidate set is
 * restricted to the two graph nodes the avatar is currently between —
 * the last node they passed on their previous polyline, and the next
 * un-passed node ahead. Other graph nodes (and especially the
 * destination itself) aren't valid entry points: the avatar must
 * enter the network at one of those two boundary nodes, then route
 * through the graph from there. This stops the avatar from "cutting
 * straight over the map" to the destination, ignoring waypoints.
 *
 * If no previous animation context is available (first call after
 * startup), fall back to nearestNode.
 */
function pickStartNode(
  start: { x: number; y: number },
  endNode: string,
  adj: Adjacency,
  prevAnim: ActorAnim | undefined,
): string {
  let prevNode: string | undefined;
  let nextNode: string | undefined;
  if (prevAnim !== undefined && prevAnim.nodes.length > 0) {
    let lastPassed = -1;
    for (let i = 0; i < prevAnim.nodes.length; i += 1) {
      if ((prevAnim.nodeLengthAt[i] ?? 0) <= prevAnim.progress + 0.01) {
        lastPassed = i;
      }
    }
    if (lastPassed >= 0) prevNode = prevAnim.nodes[lastPassed];
    if (lastPassed + 1 < prevAnim.nodes.length) {
      nextNode = prevAnim.nodes[lastPassed + 1];
    }
    if (prevNode === undefined && nextNode === undefined) {
      // Neither end resolved — pick whatever's first in the prev path.
      prevNode = prevAnim.nodes[0];
    }
  }

  const candidates: string[] = [];
  if (prevNode !== undefined) candidates.push(prevNode);
  if (nextNode !== undefined && nextNode !== prevNode) candidates.push(nextNode);
  if (candidates.length === 0) return nearestNode(start.x, start.y);

  let best: string | null = null;
  let bestCost = Infinity;
  for (const cand of candidates) {
    const candPos = POSITIONS[cand];
    if (candPos === undefined) continue;
    const distFromStart = Math.hypot(
      candPos.x - start.x,
      candPos.y - start.y,
    );
    let pathLen = 0;
    if (cand !== endNode) {
      const path = shortestPath(adj, cand, endNode);
      if (path.length < 2) continue;
      for (let i = 1; i < path.length; i += 1) {
        const a = POSITIONS[path[i - 1]!];
        const b = POSITIONS[path[i]!];
        if (a === undefined || b === undefined) continue;
        pathLen += Math.hypot(b.x - a.x, b.y - a.y);
      }
    }
    const cost = distFromStart + pathLen;
    if (cost < bestCost) {
      bestCost = cost;
      best = cand;
    }
  }
  return best ?? nearestNode(start.x, start.y);
}

function buildAnimPath(
  start: { x: number; y: number },
  target: {
    nodes: readonly string[];
    targetFraction: number;
  },
  adj: Adjacency,
  prevAnim: ActorAnim | undefined,
): {
  path: ReadonlyArray<{ x: number; y: number }>;
  lengthAt: ReadonlyArray<number>;
  nodes: ReadonlyArray<string>;
  nodeLengthAt: ReadonlyArray<number>;
  /** Where the walk should stop (in arc length). For at-location
   *  targets this equals total polyline length; for transit it's
   *  the start-node arc length plus journeyLen × targetFraction so
   *  the avatar pauses geometrically along the journey, not partway
   *  through the leading "currentPos → first node" segment. */
  targetProgress: number;
} {
  const endNode =
    target.nodes[target.nodes.length - 1] ?? nearestNode(start.x, start.y);
  const startNode = pickStartNode(start, endNode, adj, prevAnim);

  let nodeIds: string[];
  if (startNode === endNode) {
    nodeIds = [startNode];
  } else {
    nodeIds = shortestPath(adj, startNode, endNode);
    if (nodeIds.length === 0) nodeIds = [startNode, endNode];
  }

  // For a transit target (midpoint) we'd usually prefer the placement's
  // node sequence — but only when the path the placement gives starts
  // at the same node we're starting from. Otherwise Dijkstra's result
  // (which starts at our nextNodeAhead) is the right answer.
  if (
    target.targetFraction < 1 &&
    target.nodes.length > 1 &&
    target.nodes[0] === startNode
  ) {
    nodeIds = [...target.nodes];
  }

  // Construct the polyline: avatar's current position → each graph
  // node's coordinate. We do NOT append the target's xy here — that
  // was the old bug: for transit targets the appended midpoint sat
  // *after* the destination node in the polyline, so the walker went
  // forward to the destination and then doubled back to the midpoint.
  type Tagged = { x: number; y: number; nodeId: string | null };
  const polyline: Tagged[] = [{ x: start.x, y: start.y, nodeId: null }];
  for (const id of nodeIds) {
    const pos = POSITIONS[id];
    if (pos !== undefined) polyline.push({ x: pos.x, y: pos.y, nodeId: id });
  }

  // Drop consecutive duplicates; keep nodeId tags through merges.
  const cleaned: Tagged[] = [];
  for (const p of polyline) {
    const last = cleaned[cleaned.length - 1];
    if (
      last !== undefined &&
      Math.abs(p.x - last.x) < 0.1 &&
      Math.abs(p.y - last.y) < 0.1
    ) {
      if (last.nodeId === null && p.nodeId !== null) last.nodeId = p.nodeId;
      continue;
    }
    cleaned.push({ x: p.x, y: p.y, nodeId: p.nodeId });
  }
  // Always keep at least two points so pointAlongPolyline is happy
  // (zero-distance walks just sit at the start).
  if (cleaned.length === 1) {
    cleaned.push({ x: cleaned[0]!.x, y: cleaned[0]!.y, nodeId: cleaned[0]!.nodeId });
  }

  const lengthAt: number[] = [0];
  for (let i = 1; i < cleaned.length; i += 1) {
    const a = cleaned[i - 1]!;
    const b = cleaned[i]!;
    lengthAt.push((lengthAt[i - 1] ?? 0) + Math.hypot(b.x - a.x, b.y - a.y));
  }

  const fraction = Math.max(0, Math.min(1, target.targetFraction));

  const nodes: string[] = [];
  const nodeLengthAt: number[] = [];
  for (let i = 0; i < cleaned.length; i += 1) {
    const tag = cleaned[i]!.nodeId;
    if (tag !== null) {
      nodes.push(tag);
      nodeLengthAt.push(lengthAt[i] ?? 0);
    }
  }
  // targetProgress = first-graph-node length + journeyLen × fraction.
  // The lead-in segment (from start to the first graph node) is
  // "pre-walk" and doesn't count toward the journey fraction — so a
  // transit avatar with a non-zero start offset still stops at the
  // geometric midpoint of the road journey, not partway through the
  // start lead-in.
  const firstNodeLen = nodeLengthAt[0] ?? 0;
  const lastNodeLen =
    nodeLengthAt[nodeLengthAt.length - 1] ??
    lengthAt[lengthAt.length - 1] ??
    0;
  const journeyLen = Math.max(0, lastNodeLen - firstNodeLen);
  const targetProgress = firstNodeLen + journeyLen * fraction;

  return {
    path: cleaned.map((p) => ({ x: p.x, y: p.y })),
    lengthAt,
    nodes,
    nodeLengthAt,
    targetProgress,
  };
}

function nearestNode(x: number, y: number): string {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const [id, pos] of Object.entries(POSITIONS)) {
    const d = (pos.x - x) ** 2 + (pos.y - y) ** 2;
    if (d < bestDist) { bestDist = d; best = id; }
  }
  return best ?? "peckham-flat";
}

/**
 * Return the polyline segment from arc length `fromDist` to `toDist`,
 * with interpolated endpoints if those distances fall mid-segment.
 * Used to draw the "still ahead" portion of an in-transit actor's
 * route, so the line cleans up behind them as they walk.
 */
function sliceProgress(
  path: ReadonlyArray<{ x: number; y: number }>,
  lengthAt: ReadonlyArray<number>,
  fromDist: number,
  toDist: number,
): { x: number; y: number }[] {
  if (path.length < 2) return [];
  const total = lengthAt[lengthAt.length - 1] ?? 0;
  const a = Math.max(0, Math.min(total, fromDist));
  const b = Math.max(a, Math.min(total, toDist));
  if (b - a < 0.5) return [];
  const out: { x: number; y: number }[] = [];
  for (let i = 1; i < path.length; i += 1) {
    const segStart = lengthAt[i - 1] ?? 0;
    const segEnd = lengthAt[i] ?? 0;
    if (segEnd <= a) continue;
    if (segStart >= b) break;
    const p0 = path[i - 1]!;
    const p1 = path[i]!;
    const segLen = segEnd - segStart;
    if (out.length === 0) {
      const t = segLen > 0 ? (a - segStart) / segLen : 0;
      out.push({ x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t });
    }
    const portionEnd = Math.min(segEnd, b);
    const tEnd = segLen > 0 ? (portionEnd - segStart) / segLen : 1;
    out.push({
      x: p0.x + (p1.x - p0.x) * tEnd,
      y: p0.y + (p1.y - p0.y) * tEnd,
    });
  }
  return out;
}

function pointAlongPolyline(
  path: ReadonlyArray<{ x: number; y: number }>,
  lengthAt: ReadonlyArray<number>,
  dist: number,
): { x: number; y: number } {
  if (path.length === 0) return { x: 0, y: 0 };
  if (path.length === 1) return path[0]!;
  const total = lengthAt[lengthAt.length - 1] ?? 0;
  if (dist <= 0) return path[0]!;
  if (dist >= total) return path[path.length - 1]!;
  for (let i = 1; i < path.length; i += 1) {
    const a = lengthAt[i - 1]!;
    const b = lengthAt[i]!;
    if (b >= dist) {
      const t = b - a > 0 ? (dist - a) / (b - a) : 0;
      const p0 = path[i - 1]!;
      const p1 = path[i]!;
      return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
    }
  }
  return path[path.length - 1]!;
}
