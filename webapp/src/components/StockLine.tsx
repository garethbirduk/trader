import type { ReactNode } from "react";

/**
 * Two-line "fact + meta" row used wherever the UI describes a stock
 * proposition — gossip leads ("Trader Bob has 200 Nikes (shoddy) @
 * £70"), actual inventory ("has 22 Sofas (fair) @ £58/u"), deal line
 * items, pool listings, auction lots. The CONTENT differs by context
 * (gossip is claimed and possibly wrong; inventory is the ground
 * truth) but the VISUAL STRUCTURE is identical, so a divergence
 * between two of these — e.g. "gossip says shoddy, actually good" —
 * reads as the same kind of statement disagreeing.
 *
 * Pure layout: the caller composes the `fact` and `meta` content
 * with whatever refs, chips, and language the context wants. The
 * `<StockValue>` helper styles the numeric bits (quantity, unit
 * price) consistently — pass `divergent` when the value disagrees
 * with another source on the same subject (gossip conflicts).
 */
export function StockLine({
  fact,
  meta,
}: {
  readonly fact: ReactNode;
  readonly meta?: ReactNode;
}) {
  return (
    <li className="stock-line">
      <div className="stock-line-fact">{fact}</div>
      {meta !== undefined ? (
        <div className="stock-line-meta muted">{meta}</div>
      ) : null}
    </li>
  );
}

export function StockValue({
  children,
  divergent,
}: {
  readonly children: ReactNode;
  readonly divergent?: boolean | undefined;
}) {
  return (
    <span className={divergent ? "stock-value stock-value-divergent" : "stock-value"}>
      {children}
    </span>
  );
}
