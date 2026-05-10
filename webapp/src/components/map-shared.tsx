/**
 * Visual primitives shared by the runtime <MapGraph /> and the
 * <MapEditor />. Anything that decides "what does the map *look* like"
 * lives here so both views render identically; behaviour (dragging,
 * tool selection, avatar animation, route playback) stays in each
 * caller.
 */

/** SVG viewBox dimensions. Both views render in this world. */
export const WORLD_W = 1600;
export const WORLD_H = 1080;

/** Radius of a location node circle. */
export const NODE_R = 9;
/** Radius of a waypoint dot. */
export const WAYPOINT_R = 5;

/**
 * Convert a client-space (window) coordinate into the SVG's user
 * coordinate space (viewBox / world). Uses getScreenCTM so it
 * correctly accounts for `preserveAspectRatio="xMidYMid meet"`
 * letterbox / pillarbox padding when the canvas aspect doesn't match
 * the viewBox.
 */
export function clientToWorld(
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

/**
 * Cartoon basemap rendered at full opacity. Sits under everything in
 * the SVG so node positions can be eyeballed against real roads.
 * The image source is a CC0 plan of London (Geographia Pictorial,
 * Wikimedia Commons).
 */
export function MapBasemap({ visible = true }: { visible?: boolean }) {
  if (!visible) return null;
  return (
    <image
      href={`${import.meta.env.BASE_URL}map-bg.jpg`}
      x={0}
      y={0}
      width={WORLD_W}
      height={WORLD_H}
      preserveAspectRatio="none"
      style={{ pointerEvents: "none" }}
    />
  );
}

/**
 * Pill-backed label for a location node. Renders a rounded white
 * background and dark text on top so the label stays readable against
 * any region of the basemap. Width is approximated from character
 * count (12 px monospace ≈ 7.2 px/char). Positioned above the parent
 * group's origin — wrap in a <g transform="translate(...)"> at the
 * node centre.
 */
export function NodeLabel({
  text,
  yOffset = -NODE_R - 17,
  fontSize = 12,
}: {
  readonly text: string;
  /** How far above the node centre the label sits (negative = up). */
  readonly yOffset?: number;
  /** Character width estimate scales with fontSize. */
  readonly fontSize?: number;
}) {
  // Empirical char-width factor for ui-monospace at 12px ≈ 7.2;
  // scale linearly for other sizes.
  const w = text.length * (fontSize * 0.6) + 8;
  return (
    <>
      <rect
        className="node-label-bg"
        x={-w / 2}
        y={yOffset}
        width={w}
        height={fontSize + 2}
        rx={(fontSize + 2) / 2}
      />
      <text
        className="node-label"
        textAnchor="middle"
        y={yOffset + fontSize - 1}
        style={fontSize === 12 ? undefined : { fontSize }}
      >
        {text}
      </text>
    </>
  );
}

/**
 * Pill-backed badge for a small overlay on top of a node — used by
 * the runtime view for the actor-population count. Same shape as
 * NodeLabel, smaller font, sits higher above the node.
 */
export function NodePopBadge({
  text,
  yOffset = -NODE_R - 30,
}: {
  readonly text: string;
  readonly yOffset?: number;
}) {
  const w = text.length * 6.6 + 8;
  return (
    <>
      <rect
        className="node-pop-bg"
        x={-w / 2}
        y={yOffset}
        width={w}
        height={13}
        rx={6.5}
      />
      <text
        className="node-pop"
        textAnchor="middle"
        y={yOffset + 9}
      >
        {text}
      </text>
    </>
  );
}
