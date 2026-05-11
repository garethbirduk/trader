import type { RunDump } from "../types.js";
import type { Selection, SelectionKind } from "../App.js";
import { Avatar } from "./Avatar.js";
import { LocationAvatar } from "./LocationAvatar.js";
import { useCurrentTime } from "../lib/current-time.js";
import { isLocationOpenAt } from "../lib/location-open.js";

export type RefVariant = "chip" | "inline";

interface CommonRefProps {
  readonly dump: RunDump;
  readonly id: number;
  readonly onSelect: (s: Selection) => void;
  readonly variant?: RefVariant;
}

interface RefButtonProps {
  readonly kind: SelectionKind;
  readonly id: number;
  readonly onSelect: (s: Selection) => void;
  readonly variant: RefVariant;
  readonly title?: string;
  readonly extraClass?: string;
  readonly children: React.ReactNode;
}

function RefButton({
  kind,
  id,
  onSelect,
  variant,
  title,
  extraClass,
  children,
}: RefButtonProps) {
  return (
    <button
      type="button"
      className={`ref ref-${variant} ref-${kind}${extraClass ? ` ${extraClass}` : ""}`}
      onClick={() => onSelect({ kind, id })}
      title={title}
    >
      {children}
    </button>
  );
}

export interface ActorRefProps {
  readonly dump: RunDump;
  readonly id: number;
  readonly onSelect: (s: Selection) => void;
  readonly variant?: RefVariant | "avatar";
  readonly size?: number;
}

export function ActorRef({
  dump,
  id,
  onSelect,
  variant = "chip",
  size = 18,
}: ActorRefProps) {
  const a = dump.actors.find((x) => x.id === id);
  if (a === undefined) {
    return <span className="ref-missing muted">actor {id}</span>;
  }
  const isPlayer = a.id === dump.playerActorId;
  if (variant === "avatar") {
    return (
      <RefButton
        kind="actor"
        id={id}
        onSelect={onSelect}
        variant="chip"
        title={a.displayName}
        extraClass="ref-avatar-only"
      >
        <Avatar
          name={a.displayName}
          code={a.code}
          isPlayer={isPlayer}
          size={size}
        />
      </RefButton>
    );
  }
  if (variant === "inline") {
    return (
      <RefButton
        kind="actor"
        id={id}
        onSelect={onSelect}
        variant="inline"
        title={a.displayName}
      >
        {a.displayName}
      </RefButton>
    );
  }
  return (
    <RefButton
      kind="actor"
      id={id}
      onSelect={onSelect}
      variant="chip"
      title={a.displayName}
    >
      <Avatar
        name={a.displayName}
        code={a.code}
        isPlayer={isPlayer}
        size={size}
      />
      <span>{a.displayName}</span>
    </RefButton>
  );
}

export interface LocationRefProps extends CommonRefProps {
  readonly size?: number;
}

export function LocationRef({
  dump,
  id,
  onSelect,
  variant = "inline",
  size = 18,
}: LocationRefProps) {
  const { hour } = useCurrentTime();
  const loc = dump.locations.find((l) => l.id === id);
  if (loc === undefined) {
    return <span className="ref-missing muted">loc {id}</span>;
  }
  if (variant === "chip") {
    const isOpen = isLocationOpenAt(loc.openHours, hour);
    return (
      <RefButton
        kind="location"
        id={id}
        onSelect={onSelect}
        variant="chip"
        title={
          isOpen ? loc.displayName : `${loc.displayName} (closed)`
        }
      >
        <LocationAvatar
          displayName={loc.displayName}
          code={loc.code}
          type={loc.type}
          size={size}
          isOpen={isOpen}
        />
        <span>{loc.displayName}</span>
      </RefButton>
    );
  }
  return (
    <RefButton
      kind="location"
      id={id}
      onSelect={onSelect}
      variant="inline"
      title={loc.displayName}
    >
      {loc.displayName}
    </RefButton>
  );
}

export interface ItemRefProps extends CommonRefProps {
  readonly qualityTier?: string | undefined;
}

export function ItemRef({
  dump,
  id,
  onSelect,
  variant = "inline",
  qualityTier,
}: ItemRefProps) {
  const item = dump.items.find((i) => i.id === id);
  if (item === undefined) {
    return <span className="ref-missing muted">item {id}</span>;
  }
  const tierBadge =
    qualityTier !== undefined ? (
      <span className={`tier tier-${qualityTier}`}>{qualityTier}</span>
    ) : null;
  if (variant === "chip") {
    return (
      <span className="ref-with-badge">
        <RefButton
          kind="item"
          id={id}
          onSelect={onSelect}
          variant="chip"
          title={item.displayName}
        >
          <span className="ref-icon" aria-hidden="true">◆</span>
          <span>{item.displayName}</span>
        </RefButton>
        {tierBadge}
      </span>
    );
  }
  return (
    <span className="ref-with-badge">
      <RefButton
        kind="item"
        id={id}
        onSelect={onSelect}
        variant="inline"
        title={item.displayName}
      >
        {item.displayName}
      </RefButton>
      {tierBadge}
    </span>
  );
}

export function DealRef({
  dump,
  id,
  onSelect,
  variant = "inline",
}: CommonRefProps) {
  // Deals aren't in dump.actors/items/locations — they're in snapshot
  // only — so we don't validate existence here. The DealProfile resolves
  // it against the latest snapshot.
  void dump;
  const label = `deal ${id}`;
  if (variant === "chip") {
    return (
      <RefButton
        kind="deal"
        id={id}
        onSelect={onSelect}
        variant="chip"
        title={label}
      >
        <span className="ref-icon" aria-hidden="true">⇄</span>
        <span>{label}</span>
      </RefButton>
    );
  }
  return (
    <RefButton
      kind="deal"
      id={id}
      onSelect={onSelect}
      variant="inline"
      title={label}
    >
      {label}
    </RefButton>
  );
}

export function LotRef({
  dump,
  id,
  onSelect,
  variant = "inline",
}: CommonRefProps) {
  void dump;
  const label = `lot ${id}`;
  if (variant === "chip") {
    return (
      <RefButton
        kind="lot"
        id={id}
        onSelect={onSelect}
        variant="chip"
        title={label}
      >
        <span className="ref-icon" aria-hidden="true">🔨</span>
        <span>{label}</span>
      </RefButton>
    );
  }
  return (
    <RefButton
      kind="lot"
      id={id}
      onSelect={onSelect}
      variant="inline"
      title={label}
    >
      {label}
    </RefButton>
  );
}

export function PoolRef({
  dump,
  id,
  onSelect,
  variant = "inline",
}: CommonRefProps) {
  void dump;
  const label = `pool ${id}`;
  if (variant === "chip") {
    return (
      <RefButton
        kind="pool"
        id={id}
        onSelect={onSelect}
        variant="chip"
        title={label}
      >
        <span className="ref-icon" aria-hidden="true">≋</span>
        <span>{label}</span>
      </RefButton>
    );
  }
  return (
    <RefButton
      kind="pool"
      id={id}
      onSelect={onSelect}
      variant="inline"
      title={label}
    >
      {label}
    </RefButton>
  );
}
