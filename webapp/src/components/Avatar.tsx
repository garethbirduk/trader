import { getActorColor, getInitials } from "../avatar.js";

interface Props {
  readonly name: string;
  readonly code: string;
  readonly isPlayer: boolean;
  readonly size: number;
  readonly onClick?: () => void;
  readonly selected?: boolean;
  readonly title?: string;
}

export function Avatar({ name, code, isPlayer, size, onClick, selected, title }: Props) {
  const colour = getActorColor({ code, isPlayer });
  const initials = getInitials(name);
  const fontSize = Math.round(size * 0.46);
  return (
    <span
      className={`avatar ${selected ? "avatar-selected" : ""} ${onClick ? "avatar-clickable" : ""}`}
      style={{ width: size, height: size }}
      onClick={onClick}
      title={title ?? name}
      role={onClick ? "button" : undefined}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={size / 2 - 1}
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
