import { useEffect, useMemo, useRef, useState } from "react";
import type { DaySnapshot, RunDump, RunEvent } from "../types.js";
import type { Selection } from "../App.js";
import { getActorColor, getInitials } from "../avatar.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly hour: number;
  readonly snapshot: DaySnapshot | null;
  readonly selection: Selection | null;
  readonly onSelect: (s: Selection | null) => void;
}

const WORLD_W = 1600;
const WORLD_H = 1080;

// Hand-placed location coordinates. Pure abstract layout — no
// underlying basemap, no real-world geography. Just a graph.
const LOCATION_POSITIONS: Record<string, { x: number; y: number }> = {
  // Council axis (NW)
  "lambeth-council-yard": { x: 110, y: 180 },
  "council-streets": { x: 280, y: 200 },
  "trigger-flat": { x: 430, y: 110 },
  // Auction / dodgy strip (north)
  "albert-legion": { x: 600, y: 220 },
  "auction-house": { x: 820, y: 200 },
  "one-eleven-club": { x: 1000, y: 130 },
  "starlight-rooms": { x: 1180, y: 200 },
  // Off-map (NE corner)
  "off-map": { x: 1480, y: 90 },
  // Peckham core
  "raquel-flat": { x: 410, y: 310 },
  "mickey-jevon-flat": { x: 250, y: 400 },
  nags: { x: 560, y: 380 },
  "sids-cafe": { x: 640, y: 510 },
  "peckham-flat": { x: 800, y: 470 },
  "peckham-market": { x: 880, y: 580 },
  lockup: { x: 1010, y: 470 },
  "post-office": { x: 410, y: 540 },
  "betting-shop": { x: 540, y: 630 },
  // Civic / cops
  "dirty-barrys": { x: 770, y: 660 },
  "police-station": { x: 620, y: 760 },
  "slater-flat": { x: 470, y: 830 },
  // Boyce belt (SW)
  "boyce-auto-sales": { x: 380, y: 920 },
  "boycie-house": { x: 220, y: 850 },
  // Posh suburb / Parry strand (NE)
  "parry-printers": { x: 1280, y: 270 },
  "parry-house": { x: 1450, y: 340 },
  "cassandra-bank": { x: 1180, y: 350 },
  "cassandra-flat": { x: 1130, y: 480 },
  // Industrial east
  "transworld-depot": { x: 1330, y: 700 },
  "denzil-house": { x: 1480, y: 860 },
  // Deptford
  "shamrock-club": { x: 1330, y: 990 },
};

/**
 * Pure routing nodes — they don't represent a place anyone lives or
 * works, they just exist so edges have a clean corner to bend at and
 * fewer roads cross each other. Avatars can pass through them in
 * transit but never stop here. No label, no profile, no click target.
 */
const WAYPOINT_POSITIONS: Record<string, { x: number; y: number }> = {
  // West connector — between Mickey/Jevon flat, Council streets, Raquel's.
  wp_NW: { x: 280, y: 290 },
  // North junction — Trigger / Albert / Nag's converge here.
  wp_N: { x: 700, y: 290 },
  // West-south corridor — connects Mickey/Jevon down to Boycie's via Peckham fringe.
  wp_WS: { x: 290, y: 690 },
  // South junction — Police, Slater, Boyce belt meet here.
  wp_S: { x: 580, y: 870 },
  // East corner just past Lock-up — bridges Peckham to the posh suburb.
  wp_E: { x: 1110, y: 470 },
  // South-east — bridges Cassandra/Bank to Transworld/Deptford.
  wp_SE: { x: 1180, y: 720 },
};

const POSITIONS: Record<string, { x: number; y: number }> = {
  ...LOCATION_POSITIONS,
  ...WAYPOINT_POSITIONS,
};

const SHORT_LABELS: Record<string, string> = {
  "peckham-flat": "Peckham flat",
  "boycie-house": "Boycie's",
  "denzil-house": "Denzil's",
  "boyce-auto-sales": "Boyce Autos",
  "transworld-depot": "Transworld",
  "lambeth-council-yard": "Council yard",
  "auction-house": "Sotheby's",
  "council-streets": "Sweep round",
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

// Edges. Each segment is a short hop between adjacent nodes; longer
// journeys chain through waypoints / intermediate locations. No "long
// diagonal" edges that cross the whole map — Dijkstra still finds the
// shortest path through whatever's actually wired up.
const EDGES: ReadonlyArray<readonly [string, string]> = [
  // ── Council / NW corner ──────────────────────────────────────────
  ["lambeth-council-yard", "council-streets"],
  ["council-streets", "wp_NW"],
  ["trigger-flat", "wp_NW"],
  ["raquel-flat", "wp_NW"],
  ["mickey-jevon-flat", "wp_NW"],

  // ── North junction (auction strip + Trotter household) ───────────
  ["trigger-flat", "wp_N"],
  ["albert-legion", "wp_N"],
  ["nags", "wp_N"],

  // ── Auction / dodgy clubs strip (chained west→east) ──────────────
  ["albert-legion", "auction-house"],
  ["auction-house", "one-eleven-club"],
  ["one-eleven-club", "starlight-rooms"],
  ["starlight-rooms", "off-map"],

  // ── Trotter cluster around the Nag's ─────────────────────────────
  ["nags", "raquel-flat"],
  ["nags", "sids-cafe"],
  ["nags", "peckham-flat"],
  ["mickey-jevon-flat", "post-office"],

  // ── Peckham high street ──────────────────────────────────────────
  ["peckham-flat", "sids-cafe"],
  ["peckham-flat", "peckham-market"],
  ["peckham-flat", "lockup"],
  ["peckham-flat", "post-office"],
  ["peckham-flat", "dirty-barrys"],
  ["sids-cafe", "post-office"],
  ["peckham-market", "lockup"],
  ["peckham-market", "auction-house"],
  ["peckham-market", "dirty-barrys"],

  // ── Bookies / civic spine ────────────────────────────────────────
  ["post-office", "betting-shop"],
  ["betting-shop", "dirty-barrys"],
  ["betting-shop", "police-station"],
  ["dirty-barrys", "police-station"],
  ["police-station", "wp_S"],
  ["slater-flat", "wp_S"],

  // ── Boyce belt (SW) ──────────────────────────────────────────────
  ["boyce-auto-sales", "boycie-house"],
  ["boyce-auto-sales", "wp_S"],
  ["boycie-house", "wp_WS"],
  ["wp_WS", "post-office"],
  ["wp_WS", "mickey-jevon-flat"],

  // ── East / posh suburb ───────────────────────────────────────────
  ["lockup", "wp_E"],
  ["wp_E", "cassandra-flat"],
  ["wp_E", "cassandra-bank"],
  ["cassandra-flat", "cassandra-bank"],
  ["cassandra-bank", "parry-printers"],
  ["cassandra-bank", "parry-house"],
  ["parry-printers", "parry-house"],
  ["parry-printers", "auction-house"],

  // ── East-southeast bridge ────────────────────────────────────────
  ["wp_E", "wp_SE"],
  ["cassandra-flat", "wp_SE"],
  ["wp_SE", "transworld-depot"],

  // ── Industrial east ──────────────────────────────────────────────
  ["transworld-depot", "denzil-house"],
  ["transworld-depot", "shamrock-club"],
  ["shamrock-club", "off-map"],
];

const TYPE_FILL: Record<string, string> = {
  home: "#1a201a",
  pub: "#2a1a1a",
  business: "#1a1f2a",
  civic: "#1a1a2a",
  auction: "#2a2510",
  street: "#1a1a1a",
  abstract: "#0d0d12",
};
const TYPE_STROKE: Record<string, string> = {
  home: "#3a553a",
  pub: "#6b3a3a",
  business: "#3a4a6a",
  civic: "#3a466b",
  auction: "#7a6420",
  street: "#555",
  abstract: "#666",
};

const HEX_PLAYER = "#ffb84d";
const NODE_R = 9;
const AVATAR_R = 13;

function hashLabel(name: string): string {
  return name;
}

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
}

const ANIM_SPEED_PX_PER_SEC = 700;

export function MapGraph(props: Props) {
  const { dump, day, hour, selection, onSelect } = props;
  const adj = useMemo(buildAdjacency, []);
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
  const stackedAt = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const [aid, p] of placement) {
      if (p.kind !== "at") continue;
      const list = m.get(p.locationCode) ?? [];
      list.push(aid);
      m.set(p.locationCode, list);
    }
    return m;
  }, [placement]);

  // Active edges: any edge fully contained within an in-transit path.
  const activeEdgeKeys = useMemo(() => {
    const set = new Set<string>();
    for (const p of placement.values()) {
      if (p.kind !== "transit") continue;
      const nodes = p.pathInfo.nodes;
      for (let i = 1; i < nodes.length; i += 1) {
        set.add(edgeKey(nodes[i - 1]!, nodes[i]!));
      }
    }
    return set;
  }, [placement]);

  // Where each actor "wants to be" right now (end-of-current-hour).
  // Used as the animation target. The actual displayed position is
  // tweened via animsRef along the graph polyline below.
  const targets = useMemo(() => {
    const map = new Map<
      number,
      {
        x: number;
        y: number;
        transit: boolean;
        nodes: readonly string[]; // graph nodes for the journey, in order
        targetFraction: number; // 0..1 along `nodes` polyline
      }
    >();
    for (const a of dump.actors) {
      const p = placement.get(a.id);
      if (!p) continue;
      if (p.kind === "at") {
        const pos = LOCATION_POSITIONS[p.locationCode];
        if (!pos) continue;
        const list = stackedAt.get(p.locationCode) ?? [];
        const idx = list.indexOf(a.id);
        const total = list.length;
        let x = pos.x;
        let y = pos.y + NODE_R + AVATAR_R + 4;
        if (total > 1) {
          const angle = (idx / total) * Math.PI * 2 - Math.PI / 2;
          const r = NODE_R + AVATAR_R + 6;
          x = pos.x + Math.cos(angle) * r;
          y = pos.y + Math.sin(angle) * r;
        }
        map.set(a.id, {
          x,
          y,
          transit: false,
          nodes: [p.locationCode],
          targetFraction: 1,
        });
      } else {
        const mid = pointAtDistance(p.pathInfo, p.pathInfo.totalLength / 2);
        map.set(a.id, {
          x: mid.x,
          y: mid.y,
          transit: true,
          nodes: p.pathInfo.nodes,
          targetFraction: 0.5,
        });
      }
    }
    return map;
  }, [dump.actors, placement, stackedAt]);

  // Whenever targets change, build each actor's animation polyline and
  // reset progress to 0. The path is the shortest-path polyline from
  // wherever the avatar currently is to wherever they're heading,
  // including the offset from the node centre (stack jitter or transit
  // midpoint).
  useEffect(() => {
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
      // Build a polyline from current position → graph nodes → target.
      const built = buildAnimPath(
        { x: existing.x, y: existing.y },
        target,
        adj,
      );
      existing.path = built.path;
      existing.lengthAt = built.lengthAt;
      existing.progress = 0;
      existing.targetProgress = built.lengthAt[built.lengthAt.length - 1] ?? 0;
      existing.transit = target.transit;
    }
  }, [targets, adj, dump.actors]);

  // Single rAF loop driving every active animation. Re-renders the
  // component while anyone is still moving so the SVG transforms
  // refresh.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      let anyActive = false;
      for (const anim of animsRef.current.values()) {
        if (anim.progress < anim.targetProgress) {
          anim.progress = Math.min(
            anim.targetProgress,
            anim.progress + ANIM_SPEED_PX_PER_SEC * dt,
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
      if (anyActive) setFrame((n) => (n + 1) & 0x7fffffff);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
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
        {/* Edges */}
        <g className="edges">
          {EDGES.map(([a, b]) => {
            const pa = POSITIONS[a];
            const pb = POSITIONS[b];
            if (!pa || !pb) return null;
            const k = edgeKey(a, b);
            const active = activeEdgeKeys.has(k);
            return (
              <line
                key={k}
                x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
                className={`graph-edge ${active ? "graph-edge-active" : ""}`}
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

        {/* Location nodes */}
        <g className="nodes">
          {dump.locations.map((loc) => {
            const pos = POSITIONS[loc.code];
            if (!pos) return null;
            const isSel = loc.id === selLoc;
            const isAuction =
              loc.id === dump.auctionLocationId ||
              (loc as { type?: string }).type === "auction";
            const isStar =
              isAuction && dump.auctionHour !== undefined &&
              hour === dump.auctionHour;
            const t = (loc as { type?: string }).type ?? "business";
            const fill = TYPE_FILL[t] ?? "#15161c";
            const stroke = isSel || isStar ? HEX_PLAYER : (TYPE_STROKE[t] ?? "#2a2b35");
            const strokeWidth = isSel || isStar ? 2.5 : 1.5;
            const label = (isStar ? "★ " : "") +
              (SHORT_LABELS[loc.code] ?? loc.displayName);
            const pop = stackedAt.get(loc.code)?.length ?? 0;
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
                <circle
                  r={NODE_R}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                />
                <text
                  className="node-label"
                  textAnchor="middle"
                  y={-NODE_R - 6}
                >
                  {hashLabel(label)}
                </text>
                {pop > 0 ? (
                  <text className="node-pop" textAnchor="middle" y={-NODE_R - 18}>
                    {pop}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>

        {/* Avatars — driven manually by animsRef so they walk the
            polyline rather than cutting diagonally between renders. */}
        <g className="avatars">
          {dump.actors.map((actor) => {
            const anim = animsRef.current.get(actor.id);
            if (!anim) return null;
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
                <circle
                  r={AVATAR_R}
                  fill={colour}
                  stroke={isSel ? "#fff" : isPlayer ? "#fff" : "rgba(0,0,0,0.5)"}
                  strokeWidth={isSel ? 2.5 : isPlayer ? 1.5 : 1}
                  strokeDasharray={anim.transit ? "3 2" : undefined}
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
            );
          })}
        </g>
      </svg>
      <div className="map-legend muted">
        Day {day} · {String(hour).padStart(2, "0")}:00 · scroll to zoom · drag
        empty space to pan · routes path through intermediate nodes
      </div>
    </div>
  );
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Find the shortest-path polyline from a free-floating start point to
 * a target point, walking through real graph nodes wherever possible.
 * The returned `path` always begins at `start` and ends at `target`,
 * with graph node coordinates in between.
 */
function buildAnimPath(
  start: { x: number; y: number },
  target: {
    x: number;
    y: number;
    nodes: readonly string[];
    targetFraction: number;
  },
  adj: Adjacency,
): {
  path: ReadonlyArray<{ x: number; y: number }>;
  lengthAt: ReadonlyArray<number>;
} {
  const startNode = nearestNode(start.x, start.y);
  const endNode = target.nodes[target.nodes.length - 1] ?? startNode;

  let nodeIds: string[];
  if (startNode === endNode) {
    nodeIds = [startNode];
  } else {
    nodeIds = shortestPath(adj, startNode, endNode);
    if (nodeIds.length === 0) nodeIds = [startNode, endNode];
  }

  // For a transit target (midpoint), prefer the journey's actual node
  // sequence over Dijkstra's choice from the start point — they should
  // match anyway, but this makes sure waypoints render correctly when
  // multiple shortest paths exist.
  if (target.targetFraction < 1 && target.nodes.length > 1) {
    nodeIds = [...target.nodes];
  }

  // Construct the polyline: start → each node's coordinate → target.
  const polyline: { x: number; y: number }[] = [{ x: start.x, y: start.y }];
  for (const id of nodeIds) {
    const pos = POSITIONS[id];
    if (pos !== undefined) polyline.push(pos);
  }
  polyline.push({ x: target.x, y: target.y });

  // Drop consecutive duplicates so arc lengths don't include zero-length segments.
  const cleaned: { x: number; y: number }[] = [];
  for (const p of polyline) {
    const last = cleaned[cleaned.length - 1];
    if (last !== undefined &&
        Math.abs(p.x - last.x) < 0.1 &&
        Math.abs(p.y - last.y) < 0.1) continue;
    cleaned.push(p);
  }
  if (cleaned.length === 1) cleaned.push({ x: target.x, y: target.y });

  const lengthAt: number[] = [0];
  for (let i = 1; i < cleaned.length; i += 1) {
    const a = cleaned[i - 1]!;
    const b = cleaned[i]!;
    lengthAt.push((lengthAt[i - 1] ?? 0) + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return { path: cleaned, lengthAt };
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
