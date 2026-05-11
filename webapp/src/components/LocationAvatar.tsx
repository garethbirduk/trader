import { getInitials, getLocationColor } from "../avatar.js";

interface Props {
  readonly displayName: string;
  readonly code: string;
  readonly type?: string | undefined;
  readonly size: number;
  readonly selected?: boolean;
  readonly onClick?: () => void;
  readonly title?: string;
  /** Open right now? `false` dims the avatar (closed shop / pub etc.).
   *  Default `true` — i.e. always open if the caller doesn't know
   *  or doesn't care. */
  readonly isOpen?: boolean;
}

/**
 * Rounded-square location avatar — the place-shaped counterpart to the
 * circular actor `<Avatar />`. Square is the visual cue for "this is a
 * venue, not a person." Fill colour comes from the location's `type`
 * (pub / home / business / auction / civic / street) so a glance hints
 * at the kind of place. When `isOpen` is `false`, the avatar dims so
 * closed venues read as unavailable at the current hour.
 */
export function LocationAvatar({
  displayName,
  code,
  type,
  size,
  selected,
  onClick,
  title,
  isOpen,
}: Props) {
  const colour = getLocationColor({ code, type });
  const initials = getInitials(displayName);
  const fontSize = Math.round(size * 0.42);
  const rx = Math.max(2, Math.round(size * 0.22));
  const closed = isOpen === false;
  return (
    <span
      className={`avatar avatar-square ${closed ? "avatar-closed" : ""} ${selected ? "avatar-selected" : ""} ${onClick ? "avatar-clickable" : ""}`}
      style={{ width: size, height: size }}
      onClick={onClick}
      title={title ?? displayName}
      role={onClick ? "button" : undefined}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <rect
          x={0.5}
          y={0.5}
          width={size - 1}
          height={size - 1}
          rx={rx}
          fill={colour}
          stroke="rgba(0,0,0,0.4)"
          strokeWidth={1}
        />
        <text
          x={size / 2}
          y={size / 2}
          dy="0.35em"
          textAnchor="middle"
          fontSize={fontSize}
          fontWeight={600}
          fill="#0d0d12"
          fontFamily="ui-monospace, Consolas, monospace"
        >
          {initials}
        </text>
      </svg>
    </span>
  );
}
