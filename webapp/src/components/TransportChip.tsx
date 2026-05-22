/**
 * Canonical chip for an actor's transport / storage tier. Pair with an
 * ActorChip wherever the actor's `transportCapacity` was previously
 * rendered as plain text (LHS row meta strip, ActorProfile head).
 *
 * Non-interactive by default — the data model has no `kind: "transport"`
 * selection today. If filter-by-tier ships later, add an `onClick`
 * variant alongside (mirroring ActorChip's optional onClick).
 */

const TRANSPORT_LABEL: Record<string, string> = {
  none: "None",
  pocket: "Pocket",
  boot: "Boot",
  van: "Van",
  truck: "Truck",
};

const TRANSPORT_LIMIT: Record<string, number> = {
  none: 0,
  pocket: 5,
  boot: 30,
  van: 200,
  truck: 1000,
};

export function TransportChip({ capacity }: { readonly capacity: string }) {
  const label = TRANSPORT_LABEL[capacity] ?? capacity;
  const limit = TRANSPORT_LIMIT[capacity];
  const title =
    limit !== undefined
      ? `transport: ${capacity} (max ${limit}u / delivery)`
      : `transport: ${capacity}`;
  return (
    <span
      className={`transport-chip transport-chip-${capacity}`}
      title={title}
    >
      {label}
    </span>
  );
}
