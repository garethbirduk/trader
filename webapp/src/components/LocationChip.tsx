import type { ReactNode } from "react";
import { LocationAvatar } from "./LocationAvatar.js";

/** Minimum shape `LocationChip` actually consumes — keeps the chip
 *  callable from places that don't have the full engine `RunLocation`
 *  (the cast editor builds household headers from JSON, for instance). */
export interface LocationLike {
  readonly code: string;
  readonly displayName: string;
  readonly type?: string;
}

/**
 * Canonical chip for a location in directory-style surfaces (the LHS
 * Locations tab, household headers, selection chips). Parallel to
 * `ActorChip` — supports `onClick` for toggleable directory rows, an
 * on / off / some `state` for bulk-selection indicators, and two
 * `detail` levels:
 *
 *   • `simplified` — avatar + `displayName`. Compact surfaces.
 *   • `full` — avatar + `displayName` + muted `code` underneath. The
 *     LHS Locations tab row uses this — it's a directory header.
 *
 * `LocationRef` from `Refs.tsx` is for inline references that navigate
 * (selection-set replace). Use `LocationChip` when the chip is the
 * primary identity surface and click should toggle membership.
 */
export type LocationChipDetail = "full" | "simplified";

export interface LocationChipProps {
  readonly loc: LocationLike;
  readonly onClick?: () => void;
  readonly suffix?: ReactNode;
  readonly state?: "off" | "on" | "some";
  readonly size?: number;
  readonly title?: string;
  readonly detail?: LocationChipDetail;
  readonly className?: string;
  /** When `false`, the avatar dims to indicate the venue is closed at
   *  the cursor hour. Pass through from a `isLocationOpenAt` check. */
  readonly isOpen?: boolean;
}

export function LocationChip({
  loc,
  onClick,
  suffix,
  state = "off",
  size = 16,
  title,
  detail = "simplified",
  className,
  isOpen,
}: LocationChipProps) {
  const isInteractive = onClick !== undefined;
  const Tag = isInteractive ? "button" : "span";
  const tagProps = isInteractive
    ? { type: "button" as const, onClick }
    : {};
  return (
    <Tag
      className={[
        "loc-chip",
        `loc-chip-${state}`,
        `loc-chip--${detail}`,
        isInteractive ? "loc-chip-interactive" : "",
        className ?? "",
      ]
        .filter((s) => s.length > 0)
        .join(" ")}
      title={title ?? loc.displayName}
      {...tagProps}
    >
      <LocationAvatar
        displayName={loc.displayName}
        code={loc.code}
        type={loc.type}
        size={size}
        {...(isOpen !== undefined ? { isOpen } : {})}
      />
      {detail === "full" ? (
        <span className="loc-chip-names">
          <span className="loc-chip-name">{loc.displayName}</span>
          <span className="loc-chip-code muted">{loc.code}</span>
        </span>
      ) : (
        <span className="loc-chip-name">{loc.displayName}</span>
      )}
      {suffix}
    </Tag>
  );
}
