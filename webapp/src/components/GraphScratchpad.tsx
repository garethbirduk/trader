import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Throwaway in-memory graph editor. Lives only in component state —
 * nothing persists across reload. Toolbar modes drive interaction;
 * SVG canvas renders the graph clean enough to screenshot. Pan + zoom
 * mirror MapGraph: wheel to zoom (cursor-pivoted), drag empty space
 * to pan.
 */

interface NodeRec {
  readonly id: number;
  /** World-space coordinates (viewBox units). */
  readonly x: number;
  readonly y: number;
  readonly label: string;
}

interface EdgeRec {
  readonly id: number;
  readonly from: number;
  readonly to: number;
}

type Mode = "move" | "addNode" | "addEdge" | "delete";

const NODE_R = 28;
const WORLD_W = 1600;
const WORLD_H = 1000;
const MIN_ZOOM_FACTOR = 0.25;
const MAX_ZOOM_FACTOR = 4;

interface View {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const INITIAL_VIEW: View = { x: 0, y: 0, w: WORLD_W, h: WORLD_H };

export function GraphScratchpad() {
  const [nodes, setNodes] = useState<readonly NodeRec[]>([]);
  const [edges, setEdges] = useState<readonly EdgeRec[]>([]);
  const [mode, setMode] = useState<Mode>("addNode");
  const [edgePickFrom, setEdgePickFrom] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState<string>("");
  const [view, setView] = useState<View>(INITIAL_VIEW);
  const nextNodeId = useRef(1);
  const nextEdgeId = useRef(1);
  const dragNodeRef = useRef<{ id: number; dx: number; dy: number } | null>(
    null,
  );
  const panRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(
    null,
  );
  const svgRef = useRef<SVGSVGElement | null>(null);

  const nodeById = useMemo(() => {
    const m = new Map<number, NodeRec>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  /** Convert a client-space pointer event into world-space (viewBox)
   *  coordinates so nodes land at the cursor even when zoomed. */
  const worldFromEvent = useCallback(
    (e: { clientX: number; clientY: number }): { x: number; y: number } => {
      const svg = svgRef.current;
      if (svg === null) return { x: 0, y: 0 };
      const rect = svg.getBoundingClientRect();
      return {
        x: view.x + ((e.clientX - rect.left) / rect.width) * view.w,
        y: view.y + ((e.clientY - rect.top) / rect.height) * view.h,
      };
    },
    [view],
  );

  /** Wheel zoom, cursor-pivoted. Mirrors MapGraph. */
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) => {
        const factor = e.deltaY > 0 ? 1.18 : 1 / 1.18;
        const newW = Math.max(
          WORLD_W * MIN_ZOOM_FACTOR,
          Math.min(WORLD_W * MAX_ZOOM_FACTOR, v.w * factor),
        );
        const newH = newW * (WORLD_H / WORLD_W);
        if (newW === v.w) return v;
        const rect = svg.getBoundingClientRect();
        const mx = ((e.clientX - rect.left) / rect.width) * v.w + v.x;
        const my = ((e.clientY - rect.top) / rect.height) * v.h + v.y;
        const newX = mx - ((e.clientX - rect.left) / rect.width) * newW;
        const newY = my - ((e.clientY - rect.top) / rect.height) * newH;
        return { x: newX, y: newY, w: newW, h: newH };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  /** Pan via drag on empty canvas. */
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as Element;
      if (target.closest("[data-clickable]") !== null) return;
      panRef.current = {
        x: e.clientX,
        y: e.clientY,
        vx: view.x,
        vy: view.y,
      };
      svg.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      const pan = panRef.current;
      if (pan === null) return;
      const rect = svg.getBoundingClientRect();
      const scaleX = view.w / rect.width;
      const scaleY = view.h / rect.height;
      const dx = (e.clientX - pan.x) * scaleX;
      const dy = (e.clientY - pan.y) * scaleY;
      setView((v) => ({ ...v, x: pan.vx - dx, y: pan.vy - dy }));
    };
    const onPointerUp = (e: PointerEvent) => {
      if (panRef.current !== null) {
        panRef.current = null;
        try {
          svg.releasePointerCapture(e.pointerId);
        } catch {
          /* noop */
        }
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

  /** Click on empty canvas — only fires for clicks that aren't on a
   *  clickable element. Used to add nodes in addNode mode and to
   *  cancel pending edge picks. */
  const onCanvasClick = (e: React.MouseEvent) => {
    if (
      (e.target as Element).closest("[data-clickable]") !== null
    ) {
      return;
    }
    if (mode === "addNode") {
      const { x, y } = worldFromEvent(e);
      const id = nextNodeId.current++;
      setNodes((ns) => [...ns, { id, x, y, label: `N${id}` }]);
      return;
    }
    if (mode === "addEdge") {
      setEdgePickFrom(null);
    }
  };

  const onNodePointerDown = (e: React.PointerEvent, n: NodeRec) => {
    if (editingId !== null) return;
    if (mode === "delete") {
      e.stopPropagation();
      setNodes((ns) => ns.filter((x) => x.id !== n.id));
      setEdges((es) => es.filter((x) => x.from !== n.id && x.to !== n.id));
      return;
    }
    if (mode === "addEdge") {
      e.stopPropagation();
      if (edgePickFrom === null) {
        setEdgePickFrom(n.id);
        return;
      }
      if (edgePickFrom !== n.id) {
        const exists = edges.some(
          (x) =>
            (x.from === edgePickFrom && x.to === n.id) ||
            (x.from === n.id && x.to === edgePickFrom),
        );
        if (!exists) {
          const id = nextEdgeId.current++;
          setEdges((es) => [...es, { id, from: edgePickFrom, to: n.id }]);
        }
      }
      setEdgePickFrom(null);
      return;
    }
    if (mode === "move") {
      e.stopPropagation();
      const pt = worldFromEvent(e);
      dragNodeRef.current = {
        id: n.id,
        dx: pt.x - n.x,
        dy: pt.y - n.y,
      };
      (e.target as Element).setPointerCapture?.(e.pointerId);
    }
  };

  const onNodePointerMove = (e: React.PointerEvent) => {
    const drag = dragNodeRef.current;
    if (drag === null) return;
    const pt = worldFromEvent(e);
    setNodes((ns) =>
      ns.map((n) =>
        n.id === drag.id ? { ...n, x: pt.x - drag.dx, y: pt.y - drag.dy } : n,
      ),
    );
  };

  const onNodePointerUp = (e: React.PointerEvent) => {
    dragNodeRef.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  const onNodeDoubleClick = (n: NodeRec) => {
    setEditingId(n.id);
    setEditingValue(n.label);
  };

  const commitLabel = () => {
    if (editingId === null) return;
    const v = editingValue.trim();
    setNodes((ns) =>
      ns.map((n) =>
        n.id === editingId ? { ...n, label: v.length > 0 ? v : n.label } : n,
      ),
    );
    setEditingId(null);
    setEditingValue("");
  };

  const onEdgeClick = (eRec: EdgeRec) => {
    if (mode === "delete") {
      setEdges((es) => es.filter((x) => x.id !== eRec.id));
    }
  };

  const clearAll = () => {
    setNodes([]);
    setEdges([]);
    setEdgePickFrom(null);
    setEditingId(null);
  };

  const resetView = () => setView(INITIAL_VIEW);

  const zoomBy = (factor: number) => {
    setView((v) => {
      const newW = Math.max(
        WORLD_W * MIN_ZOOM_FACTOR,
        Math.min(WORLD_W * MAX_ZOOM_FACTOR, v.w * factor),
      );
      if (newW === v.w) return v;
      const newH = newW * (WORLD_H / WORLD_W);
      // Pivot around viewBox centre when zooming via buttons.
      const cx = v.x + v.w / 2;
      const cy = v.y + v.h / 2;
      return { x: cx - newW / 2, y: cy - newH / 2, w: newW, h: newH };
    });
  };

  return (
    <div className="scratchpad">
      <div className="scratchpad-toolbar">
        <ModeBtn label="Add node" active={mode === "addNode"} onClick={() => setMode("addNode")} hint="Click empty canvas to drop a node" />
        <ModeBtn label="Add edge" active={mode === "addEdge"} onClick={() => { setMode("addEdge"); setEdgePickFrom(null); }} hint="Click two nodes to connect" />
        <ModeBtn label="Move" active={mode === "move"} onClick={() => setMode("move")} hint="Drag nodes to reposition" />
        <ModeBtn label="Delete" active={mode === "delete"} onClick={() => setMode("delete")} hint="Click a node or edge to remove" />
        <span className="scratchpad-divider" />
        <button type="button" className="scratchpad-btn" onClick={() => zoomBy(1 / 1.4)} title="Zoom in">+</button>
        <button type="button" className="scratchpad-btn" onClick={() => zoomBy(1.4)} title="Zoom out">−</button>
        <button type="button" className="scratchpad-btn" onClick={resetView} title="Reset view to home position">Reset view</button>
        <span className="scratchpad-divider" />
        <button type="button" className="scratchpad-btn" onClick={clearAll} title="Wipe canvas">Clear</button>
        <span className="scratchpad-hint muted">
          {modeHint(mode)} · double-click a node to rename · scroll to zoom · drag empty space to pan
        </span>
      </div>
      <div className="scratchpad-canvas-wrap">
        <svg
          ref={svgRef}
          className="scratchpad-canvas"
          xmlns="http://www.w3.org/2000/svg"
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          preserveAspectRatio="xMidYMid meet"
          onClick={onCanvasClick}
          onPointerMove={onNodePointerMove}
          onPointerUp={onNodePointerUp}
        >
          {edges.map((e) => {
            const a = nodeById.get(e.from);
            const b = nodeById.get(e.to);
            if (a === undefined || b === undefined) return null;
            return (
              <line
                key={e.id}
                className="scratch-edge"
                data-clickable="1"
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                onClick={() => onEdgeClick(e)}
              />
            );
          })}
          {nodes.map((n) => {
            const isPick = edgePickFrom === n.id;
            return (
              <g
                key={n.id}
                className={`scratch-node ${isPick ? "scratch-node-picked" : ""}`}
                data-clickable="1"
                onPointerDown={(ev) => onNodePointerDown(ev, n)}
                onDoubleClick={() => onNodeDoubleClick(n)}
              >
                <circle cx={n.x} cy={n.y} r={NODE_R} />
                {editingId === n.id ? null : (
                  <text x={n.x} y={n.y} textAnchor="middle" dominantBaseline="central">
                    {n.label}
                  </text>
                )}
              </g>
            );
          })}
          {editingId !== null && nodeById.has(editingId)
            ? (() => {
                const n = nodeById.get(editingId)!;
                return (
                  <foreignObject
                    x={n.x - NODE_R}
                    y={n.y - 10}
                    width={NODE_R * 2}
                    height={20}
                    data-clickable="1"
                  >
                    <input
                      autoFocus
                      className="scratch-node-input"
                      value={editingValue}
                      onChange={(e) => setEditingValue(e.target.value)}
                      onBlur={commitLabel}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitLabel();
                        if (e.key === "Escape") {
                          setEditingId(null);
                          setEditingValue("");
                        }
                      }}
                    />
                  </foreignObject>
                );
              })()
            : null}
        </svg>
      </div>
    </div>
  );
}

function modeHint(m: Mode): string {
  switch (m) {
    case "addNode":
      return "click empty space to add";
    case "addEdge":
      return "click two nodes to connect";
    case "move":
      return "drag nodes to reposition";
    case "delete":
      return "click a node or edge to delete";
  }
}

function ModeBtn({
  label,
  active,
  onClick,
  hint,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly hint: string;
}) {
  return (
    <button
      type="button"
      className={`scratchpad-btn ${active ? "scratchpad-btn-active" : ""}`}
      onClick={onClick}
      title={hint}
    >
      {label}
    </button>
  );
}
