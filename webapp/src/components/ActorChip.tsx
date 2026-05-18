import type { ReactNode } from "react";
import type { RunActor, RunDump } from "../types.js";
import { Avatar } from "./Avatar.js";
import { chipName } from "../lib/actor-names.js";

/**
 * The one canonical actor reference. Use this anywhere an actor name
 * needs to appear, with two narrow exceptions:
 *
 *   • The LHS Actors list — that row layout shows the full canonical
 *     `displayName` (it's a directory, not a chip surface).
 *   • The POV dropdown — `<select>` options can't host React, and the
 *     dropdown is a "pick a playable character" list, so it uses
 *     full names too.
 *
 * Everywhere else (selection chips, mini-rows under locations, the
 * "owned by" pill, stock-tab group headers, knowledge banners,
 * embedded references in events, …) is an ActorChip.
 *
 * Format mirrors the spirit of `BeliefChip` for stock: one small
 * boxed pill with an avatar prefix and the actor's *nickname*
 * (`shortName ?? displayName`).
 */
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
  /** Tooltip text override. Defaults to displayName. */
  readonly title?: string;
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
  className,
}: ActorChipProps) {
  const label = chipName(actor);
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
        isInteractive ? "actor-chip-interactive" : "",
        className ?? "",
      ]
        .filter((s) => s.length > 0)
        .join(" ")}
      title={title ?? actor.displayName}
      {...tagProps}
    >
      <Avatar name={actor.displayName} code={actor.code} isPlayer={isPlayer} size={size} />
      <span className="actor-chip-name">{label}</span>
      {suffix}
    </Tag>
  );
}
