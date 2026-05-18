import type { ReactNode } from "react";
import type { RunActor, RunDump } from "../types.js";
import { Avatar } from "./Avatar.js";
import { chipName, fullName } from "../lib/actor-names.js";

/**
 * The one canonical actor reference. Use this anywhere an actor name
 * needs to appear (see docs/ui-rules.md → Components Rule 1).
 *
 * Two detail levels (Rule 3):
 *   • detail="simplified" (default) — avatar + `shortName`. Compact
 *     surfaces: selection chips, owner pills, mini rows, header
 *     triggers.
 *   • detail="full" — avatar + composed full name (`firstName` + ` ` +
 *     `lastName`, falling back to `displayName`). Directory surfaces:
 *     the POV dropdown options, the LHS Actors list, profile headers.
 */
export type ActorChipDetail = "full" | "simplified";

export interface ActorChipProps {
  readonly actor: RunActor;
  readonly dump: RunDump;
  readonly onClick?: () => void;
  /** Optional element rendered after the name — typically a × remove
   *  button on the selection chip row. */
  readonly suffix?: ReactNode;
  /** Bulk-selection tri-state, when the chip represents a bulk
   *  operator. Defaults to "off". */
  readonly state?: "off" | "on" | "some";
  /** Avatar diameter — defaults to 16. */
  readonly size?: number;
  /** Tooltip text override. Defaults to the full name. */
  readonly title?: string;
  /** Detail level. Default is `"simplified"`; pass `"full"` for
   *  directory-style surfaces. See Components Rule 3. */
  readonly detail?: ActorChipDetail;
  /** Extra class for context-specific layout (e.g. selection-chip
   *  width caps, owner-pill padding). */
  readonly className?: string;
}

export function ActorChip({
  actor,
  dump,
  onClick,
  suffix,
  state = "off",
  size = 16,
  title,
  detail = "simplified",
  className,
}: ActorChipProps) {
  const label = detail === "full" ? fullName(actor) : chipName(actor);
  const isPlayer = actor.id === dump.playerActorId;
  const isInteractive = onClick !== undefined;
  // Plain span when non-interactive — avoids nesting <button> elements
  // (e.g. inside the selection-chip's outer <span> with its own × btn).
  const Tag = isInteractive ? "button" : "span";
  const tagProps = isInteractive
    ? { type: "button" as const, onClick }
    : {};
  return (
    <Tag
      className={[
        "actor-chip",
        `actor-chip-${state}`,
        `actor-chip--${detail}`,
        isInteractive ? "actor-chip-interactive" : "",
        className ?? "",
      ]
        .filter((s) => s.length > 0)
        .join(" ")}
      title={title ?? fullName(actor)}
      {...tagProps}
    >
      <Avatar name={actor.displayName} code={actor.code} isPlayer={isPlayer} size={size} />
      <span className="actor-chip-name">{label}</span>
      {suffix}
    </Tag>
  );
}
