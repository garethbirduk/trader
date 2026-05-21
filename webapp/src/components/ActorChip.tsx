import type { ReactNode } from "react";
import type { RunActor, RunDump } from "../types.js";
import type { Selection } from "../App.js";
import { Avatar } from "./Avatar.js";
import { chipName, fullName } from "../lib/actor-names.js";

/**
 * The one canonical actor reference. Use this anywhere an actor name
 * needs to appear (ui-rules.md Components Rule 1 + Rule 3).
 *
 * Single chip, no variants: the visible label is the nickname
 * (`chipName`, which falls back to `firstName + lastName`), and the
 * full name lives in the hover `title`. The only place actor names
 * appear outside this chip is the admin character editor, where they
 * are edit boxes.
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
  /** Tooltip text override. Defaults to the full name. */
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
      title={title ?? fullName(actor)}
      {...tagProps}
    >
      <Avatar name={actor.displayName} code={actor.code} isPlayer={isPlayer} size={size} />
      <span className="actor-chip-name">{chipName(actor)}</span>
      {suffix}
    </Tag>
  );
}

/**
 * Id-resolving adapter for the canonical `ActorChip`. Event-driven
 * surfaces (SceneDeck, CalendarView, profiles) hold actor ids rather
 * than `RunActor` objects, so this wrapper does the dump lookup and
 * wires `onSelect({ kind: "actor", id })` to the chip's `onClick`.
 *
 * Rendering still goes through the canonical chip — there is only one
 * actor presentation surface. Pass-through props mirror the canonical
 * `ActorChipProps`. If the id can't be resolved against `dump.actors`,
 * a muted fallback is rendered so missing data is visible but doesn't
 * break the surface.
 */
export interface ActorChipByIdProps {
  readonly dump: RunDump;
  readonly actorId: number;
  readonly onSelect?: (s: Selection) => void;
  readonly suffix?: ReactNode;
  readonly state?: "off" | "on" | "some";
  readonly size?: number;
  readonly title?: string;
  readonly className?: string;
}

export function ActorChipById({
  dump,
  actorId,
  onSelect,
  suffix,
  state,
  size,
  title,
  className,
}: ActorChipByIdProps) {
  const actor = dump.actors.find((a) => a.id === actorId);
  if (actor === undefined) {
    return <span className="actor-chip-missing muted">actor {actorId}</span>;
  }
  const onClick =
    onSelect !== undefined
      ? () => onSelect({ kind: "actor", id: actorId })
      : undefined;
  return (
    <ActorChip
      actor={actor}
      dump={dump}
      {...(onClick !== undefined ? { onClick } : {})}
      {...(suffix !== undefined ? { suffix } : {})}
      {...(state !== undefined ? { state } : {})}
      {...(size !== undefined ? { size } : {})}
      {...(title !== undefined ? { title } : {})}
      {...(className !== undefined ? { className } : {})}
    />
  );
}
