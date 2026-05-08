import { useEffect, useMemo, useRef, useState } from "react";
import type { RunDump } from "../types.js";
import {
  DEFAULT_LAYOUT,
  combinedPositions,
  resetLayout,
  saveLayout,
  useLayout,
  type MapLayout,
} from "../map-layout.js";

interface Props {
  readonly dump: RunDump;
}

const WORLD_W = 1600;
const WORLD_H = 1080;
const SNAP_GRID = 10;
const NODE_R = 9;
const WAYPOINT_R = 5;

type Tool = "move" | "addWp" | "edge" | "delete" | "deleteEdge" | "offMap";
interface ViewState { x: number; y: number; w: number; h: number }

const DEFAULT_VIEW: ViewState = { x: 0, y: 0, w: WORLD_W, h: WORLD_H };

/**
 * Debug-only map editor. Loads the live layout (locations, waypoints,
 * edges), lets you drag nodes, drop new waypoints, toggle edges, and
 * delete waypoints. "Save" overwrites the live layout and persists to
 * localStorage; the runtime map view picks up the change immediately
 * via the `useLayout` hook.
 *
 * Gated behind `import.meta.env.DEV` from App.tsx so it never ships.
 */
export function MapEditor({ dump }: Props) {
  const live = useLayout();
  const [draft, setDraft] = useState<MapLayout>(() => deepClone(live));
  const labelByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of dump.locations) m.set(l.code, l.displayName);
    return m;
  }, [dump.locations]);
  const [tool, setTool] = useState<Tool>("move");
  const [edgeFirst, setEdgeFirst] = useState<string | null>(null);
  const [view, setView] = useState<ViewState>(DEFAULT_VIEW);
  const [bgVisible, setBgVisible] = useState(true);
  const [bgOpacity, setBgOpacity] = useState(0.7);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<
    | { kind: "node"; nodeId: string; ox: number; oy: number }
    | {
        kind: "pan";
        sx: number;
        sy: number;
        viewBefore: ViewState;
      }
    | null
  >(null);

  // If the live layout changes from outside (factory reset, another
  // tab) and the user hasn't started editing, mirror it into the draft.
  useEffect(() => {
    setDraft((d) => (sameLayout(d, live) ? d : deepClone(live)));
  }, [live]);

  const dirty = useMemo(() => !sameLayout(draft, live), [draft, live]);
  const positions = useMemo(() => combinedPositions(draft), [draft]);

  // Wheel zoom (cursor-pivoted, accounting for meet-padding via CTM).
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
        const w = clientToWorld(svg, e.clientX, e.clientY);
        if (w === null) return v;
        // Pivot: keep cursor over the same world point.
        const fx = (w.x - v.x) / v.w; // 0..1 along x
        const fy = (w.y - v.y) / v.h;
        return {
          x: w.x - fx * newW,
          y: w.y - fy * newH,
          w: newW,
          h: newH,
        };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  // Pointer events: drag nodes / pan empty space. All client→world
  // conversions go through getScreenCTM via clientToWorld() so meet-
  // padding doesn't desync the cursor from the dragged node.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.kind === "pan") {
        // Pixels → world units. screen scale is uniform under
        // xMidYMid meet, so we can derive it from the SVG's CTM and
        // apply a single ratio.
        const ctm = svg.getScreenCTM();
        if (ctm === null) return;
        const screenScale = ctm.a; // pixel/worldUnit (uniform; ctm.d should match)
        const dxWorld = (e.clientX - drag.sx) / screenScale;
        const dyWorld = (e.clientY - drag.sy) / screenScale;
        setView({
          ...drag.viewBefore,
          x: drag.viewBefore.x - dxWorld,
          y: drag.viewBefore.y - dyWorld,
        });
        return;
      }
      // Node drag.
      const w = clientToWorld(svg, e.clientX, e.clientY);
      if (!w) return;
      const newX = snap(w.x - drag.ox);
      const newY = snap(w.y - drag.oy);
      setDraft((d) => moveNode(d, drag.nodeId, newX, newY));
    };
    const onUp = (e: PointerEvent) => {
      if (dragRef.current !== null) {
        dragRef.current = null;
        try { svg.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      }
    };
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointercancel", onUp);
    return () => {
      svg.removeEventListener("pointermove", onMove);
      svg.removeEventListener("pointerup", onUp);
      svg.removeEventListener("pointercancel", onUp);
    };
  }, []);

  // Click handlers driven by current tool.
  const handleNodePointerDown = (e: React.PointerEvent, nodeId: string) => {
    e.stopPropagation();
    if (tool === "move") {
      const pos = positions[nodeId];
      if (!pos) return;
      const svg = svgRef.current;
      if (!svg) return;
      const w = clientToWorld(svg, e.clientX, e.clientY);
      if (!w) return;
      dragRef.current = { kind: "node", nodeId, ox: w.x - pos.x, oy: w.y - pos.y };
      svg.setPointerCapture(e.pointerId);
    } else if (tool === "edge") {
      if (edgeFirst === null) {
        setEdgeFirst(nodeId);
      } else if (edgeFirst === nodeId) {
        setEdgeFirst(null);
      } else {
        setDraft((d) => toggleEdge(d, edgeFirst, nodeId));
        setEdgeFirst(null);
      }
    } else if (tool === "delete") {
      if (nodeId in draft.waypoints) {
        setDraft((d) => deleteWaypoint(d, nodeId));
      }
    } else if (tool === "offMap") {
      if (nodeId in draft.locations) {
        setDraft((d) => toggleOffMap(d, nodeId));
      }
    }
  };

  const handleSvgPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest("[data-clickable]")) return;
    const svg = svgRef.current;
    if (!svg) return;
    const w = clientToWorld(svg, e.clientX, e.clientY);
    if (!w) return;
    if (tool === "addWp") {
      setDraft((d) => addWaypoint(d, snap(w.x), snap(w.y)));
      return;
    }
    if (tool === "edge" && edgeFirst !== null) {
      setEdgeFirst(null);
      return;
    }
    // Otherwise: pan.
    dragRef.current = {
      kind: "pan",
      sx: e.clientX,
      sy: e.clientY,
      viewBefore: view,
    };
    svg.setPointerCapture(e.pointerId);
  };

  const edgeSet = useMemo(() => new Set(draft.edges.map(([a, b]) => edgeKey(a, b))), [draft.edges]);

  return (
    <div className="map-view">
      <div className="editor-toolbar">
        <ToolButton tool="move" current={tool} setTool={setTool} setEdgeFirst={setEdgeFirst}>
          Move / pan
        </ToolButton>
        <ToolButton tool="addWp" current={tool} setTool={setTool} setEdgeFirst={setEdgeFirst}>
          + Waypoint
        </ToolButton>
        <ToolButton tool="edge" current={tool} setTool={setTool} setEdgeFirst={setEdgeFirst}>
          Toggle edge
        </ToolButton>
        <ToolButton tool="delete" current={tool} setTool={setTool} setEdgeFirst={setEdgeFirst}>
          Delete waypoint
        </ToolButton>
        <ToolButton tool="deleteEdge" current={tool} setTool={setTool} setEdgeFirst={setEdgeFirst}>
          Delete edge
        </ToolButton>
        <ToolButton tool="offMap" current={tool} setTool={setTool} setEdgeFirst={setEdgeFirst}>
          Toggle off-map
        </ToolButton>
        <div className="editor-toolbar-spacer" />
        <label className="editor-bg-toggle">
          <input
            type="checkbox"
            checked={bgVisible}
            onChange={(e) => setBgVisible(e.target.checked)}
          />
          basemap
        </label>
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={bgOpacity}
          disabled={!bgVisible}
          onChange={(e) => setBgOpacity(Number(e.target.value))}
          title="basemap opacity"
          style={{ width: 80 }}
        />
        <span className="editor-toolbar-info muted">
          {Object.keys(draft.locations).length} loc · {Object.keys(draft.waypoints).length} wp · {draft.edges.length} edges
          {dirty ? " · unsaved" : ""}
          {tool === "edge" && edgeFirst !== null ? ` · edge from ${edgeFirst}…` : ""}
        </span>
        <button
          className="danger"
          onClick={() => {
            if (
              draft.edges.length === 0 ||
              window.confirm(
                `Clear all ${draft.edges.length} edges? Nodes stay where they are; you'll redraw the roads with the Toggle edge tool.`,
              )
            ) {
              setDraft((d) => ({ ...d, edges: [] }));
              setEdgeFirst(null);
              setTool("edge");
            }
          }}
          title="Wipe every edge — keeps nodes, redraw with Toggle edge"
        >
          Clear edges
        </button>
        <button
          onClick={() => setDraft(deepClone(live))}
          disabled={!dirty}
          title="Drop unsaved edits"
        >
          Discard
        </button>
        <button
          onClick={() => {
            if (window.confirm("Reset to factory layout? Discards all saved edits.")) {
              resetLayout();
              setDraft(deepClone(DEFAULT_LAYOUT));
            }
          }}
        >
          Reset to defaults
        </button>
        <button
          className="primary"
          onClick={() => saveLayout(draft)}
          disabled={!dirty}
        >
          Save
        </button>
      </div>
      <svg
        ref={svgRef}
        className="graph-map editor-svg"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={handleSvgPointerDown}
        style={{
          cursor:
            tool === "addWp"
              ? "crosshair"
              : tool === "delete" || tool === "deleteEdge"
                ? "not-allowed"
                : tool === "edge"
                  ? "cell"
                  : "grab",
        }}
      >
        {/* Cartoon basemap — sits under everything in the editor too,
            so node positions can be eyeballed against real roads. */}
        {bgVisible ? (
          <image
            href="/map-bg.jpg"
            x={0}
            y={0}
            width={WORLD_W}
            height={WORLD_H}
            opacity={bgOpacity}
            preserveAspectRatio="none"
            style={{ pointerEvents: "none" }}
          />
        ) : null}
        {/* Edges. In deleteEdge mode each visible line is paired
            with a transparent thicker hit-line so the user can click
            anywhere along the road to remove it. */}
        <g className="edges">
          {draft.edges.map(([a, b]) => {
            const pa = positions[a];
            const pb = positions[b];
            if (!pa || !pb) return null;
            const k = edgeKey(a, b);
            return (
              <g key={k}>
                <line
                  x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
                  className="graph-edge"
                />
                {tool === "deleteEdge" ? (
                  <line
                    x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
                    className="editor-edge-hit"
                    data-clickable
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDraft((d) => removeEdge(d, a, b));
                    }}
                  />
                ) : null}
              </g>
            );
          })}
        </g>

        {/* Waypoints (small dots) */}
        <g className="waypoints">
          {Object.entries(draft.waypoints).map(([id, pos]) => {
            const isEdgeFirst = id === edgeFirst;
            return (
              <g
                key={id}
                transform={`translate(${pos.x}, ${pos.y})`}
                data-clickable
                onPointerDown={(e) => handleNodePointerDown(e, id)}
                style={{
                  cursor:
                    tool === "delete" ? "pointer" : tool === "edge" ? "cell" : "move",
                }}
              >
                <circle
                  r={WAYPOINT_R + 4}
                  fill="transparent"
                />
                <circle
                  r={WAYPOINT_R}
                  className={`editor-waypoint ${isEdgeFirst ? "editor-edge-first" : ""}`}
                />
                <text className="editor-wp-label" textAnchor="middle" y={-WAYPOINT_R - 4}>
                  {id}
                </text>
              </g>
            );
          })}
        </g>

        {/* Locations */}
        <g className="nodes">
          {Object.entries(draft.locations).map(([code, pos]) => {
            const isEdgeFirst = code === edgeFirst;
            const isOff = draft.offMap[code] === true;
            return (
              <g
                key={code}
                transform={`translate(${pos.x}, ${pos.y})`}
                data-clickable
                onPointerDown={(e) => handleNodePointerDown(e, code)}
                style={{
                  cursor:
                    tool === "edge" ? "cell"
                      : tool === "offMap" ? "pointer"
                      : tool === "move" ? "move"
                      : "default",
                }}
              >
                <circle
                  r={NODE_R + 5}
                  fill="transparent"
                />
                <circle
                  r={NODE_R}
                  className={`editor-loc ${isEdgeFirst ? "editor-edge-first" : ""} ${isOff ? "editor-loc-offmap" : ""}`}
                />
                <text
                  className={`node-label ${isOff ? "editor-loc-offmap-label" : ""}`}
                  textAnchor="middle"
                  y={-NODE_R - 6}
                >
                  {(isOff ? "⌧ " : "") + (labelByCode.get(code) ?? code)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="map-legend muted">
        Editor — drag to move, click empty space to add waypoint (in
        + Waypoint mode), shift-click two nodes to toggle an edge…
        actually just pick a tool above. Save persists to localStorage
        and updates the Map tab.
      </div>
    </div>
  );

  function ToolButton({
    tool: t, current, setTool, setEdgeFirst, children,
  }: {
    tool: Tool;
    current: Tool;
    setTool: (t: Tool) => void;
    setEdgeFirst: (v: string | null) => void;
    children: React.ReactNode;
  }) {
    return (
      <button
        className={`editor-tool ${current === t ? "active" : ""}`}
        onClick={() => { setTool(t); setEdgeFirst(null); }}
      >
        {children}
      </button>
    );
  }

  function snap(v: number): number {
    return Math.round(v / SNAP_GRID) * SNAP_GRID;
  }
}

function moveNode(layout: MapLayout, id: string, x: number, y: number): MapLayout {
  if (id in layout.locations) {
    return { ...layout, locations: { ...layout.locations, [id]: { x, y } } };
  }
  if (id in layout.waypoints) {
    return { ...layout, waypoints: { ...layout.waypoints, [id]: { x, y } } };
  }
  return layout;
}

function addWaypoint(layout: MapLayout, x: number, y: number): MapLayout {
  let n = 1;
  while (`wp_${n}` in layout.waypoints) n += 1;
  const id = `wp_${n}`;
  return { ...layout, waypoints: { ...layout.waypoints, [id]: { x, y } } };
}

function deleteWaypoint(layout: MapLayout, id: string): MapLayout {
  if (!(id in layout.waypoints)) return layout;
  const { [id]: _, ...rest } = layout.waypoints;
  void _;
  return {
    ...layout,
    waypoints: rest,
    edges: layout.edges.filter(([a, b]) => a !== id && b !== id),
  };
}

function toggleEdge(layout: MapLayout, a: string, b: string): MapLayout {
  const key = edgeKey(a, b);
  const exists = layout.edges.some(([x, y]) => edgeKey(x, y) === key);
  if (exists) {
    return {
      ...layout,
      edges: layout.edges.filter(([x, y]) => edgeKey(x, y) !== key),
    };
  }
  return { ...layout, edges: [...layout.edges, [a, b]] };
}

function removeEdge(layout: MapLayout, a: string, b: string): MapLayout {
  const key = edgeKey(a, b);
  return {
    ...layout,
    edges: layout.edges.filter(([x, y]) => edgeKey(x, y) !== key),
  };
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function toggleOffMap(layout: MapLayout, code: string): MapLayout {
  const next: Record<string, true> = { ...layout.offMap };
  if (next[code] === true) {
    delete next[code];
  } else {
    next[code] = true;
  }
  return { ...layout, offMap: next };
}

/**
 * Convert a client-space (window) coordinate into the SVG's user
 * coordinate space (viewBox / world). Uses getScreenCTM so it correctly
 * accounts for `preserveAspectRatio="xMidYMid meet"` letterbox /
 * pillarbox padding when the canvas aspect doesn't match the viewBox.
 */
function clientToWorld(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const ctm = svg.getScreenCTM();
  if (ctm === null) return null;
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const local = pt.matrixTransform(ctm.inverse());
  return { x: local.x, y: local.y };
}

function deepClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

function sameLayout(a: MapLayout, b: MapLayout): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
