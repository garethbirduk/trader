import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Selection, SelectionKind } from "../App.js";
import { usePovOptional } from "./pov.js";

/**
 * Selection set — first-class multi-entity selection (docs/ui.md §7).
 *
 * The set is heterogeneous: actors, locations, stock items, deals,
 * lots, pools, plus item-kinds (which the existing `Selection` type
 * already covers via kind="item"). Supersedes the previous single-
 * selection history hook.
 *
 * Back-compat: `primary` is the most-recently-added entity. Today's
 * components consume `props.selection: Selection | null` — we feed
 * `primary` into that slot, so single-entity selections behave
 * identically to today.
 *
 * History: back/forward navigates the SET, not the primary. Pressing
 * Back undoes the most recent add/remove/replace.
 *
 * Auto-add-player rule (§7.3): when POV is a player actor and the set
 * empties (e.g. via clear or removing the last chip), the player
 * auto-re-adds. Admin POV permits an empty set.
 */

export type SelectionItem = Selection;
export type { SelectionKind };

const MAX_HISTORY = 100;

interface HistoryState {
  readonly entries: readonly (readonly SelectionItem[])[];
  /** Index of the currently-displayed set within `entries`. */
  readonly cursor: number;
}

export interface SelectionSetApi {
  /** Full selection set, ordered oldest → newest. */
  readonly items: readonly SelectionItem[];
  /** Most-recently-added item; null when set is empty. Drives the
   *  back-compat `selection` prop on existing components. */
  readonly primary: SelectionItem | null;
  readonly has: (item: SelectionItem) => boolean;
  /** Add to the set; no-op if already present. Promotes to primary. */
  readonly add: (item: SelectionItem) => void;
  /** Remove from the set; no-op if absent. */
  readonly remove: (item: SelectionItem) => void;
  /** Add if absent, remove if present. */
  readonly toggle: (item: SelectionItem) => void;
  /** Clear-and-add. `null` clears. Today's call sites that did
   *  `setSelection(s)` map to this — preserves existing single-select
   *  click behaviour without modifier keys. */
  readonly replace: (item: SelectionItem | null) => void;
  readonly clear: () => void;
  /** Bulk replacement: swap the entire current set for `items`. One
   *  history push. Used by the POV-transition prune. */
  readonly setItems: (items: readonly SelectionItem[]) => void;
  /** Back-compat alias for `replace`. Existing components written
   *  against the single-selection API can keep calling this. */
  readonly setSelection: (item: SelectionItem | null) => void;
  readonly goBack: () => void;
  readonly goForward: () => void;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

function itemEquals(a: SelectionItem, b: SelectionItem): boolean {
  return a.kind === b.kind && a.id === b.id;
}

function listsEqual(
  a: readonly SelectionItem[],
  b: readonly SelectionItem[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!itemEquals(a[i]!, b[i]!)) return false;
  }
  return true;
}

const Ctx = createContext<SelectionSetApi | null>(null);

export interface SelectionSetProviderProps {
  readonly initial?: readonly SelectionItem[];
  readonly children: ReactNode;
}

export function SelectionSetProvider(props: SelectionSetProviderProps) {
  const povApi = usePovOptional();
  const initial = props.initial ?? [];
  const [state, setState] = useState<HistoryState>(() => ({
    entries: [initial],
    cursor: 0,
  }));

  const current = state.entries[state.cursor] ?? [];

  const pushSet = useCallback((next: readonly SelectionItem[]) => {
    setState((prev) => {
      const cur = prev.entries[prev.cursor] ?? [];
      if (listsEqual(cur, next)) return prev;
      const kept = prev.entries.slice(0, prev.cursor + 1);
      const appended = [...kept, next];
      const overflow = appended.length - MAX_HISTORY;
      const trimmed = overflow > 0 ? appended.slice(overflow) : appended;
      return { entries: trimmed, cursor: trimmed.length - 1 };
    });
  }, []);

  const has = useCallback(
    (item: SelectionItem) => current.some((i) => itemEquals(i, item)),
    [current],
  );

  const add = useCallback(
    (item: SelectionItem) => {
      if (current.some((i) => itemEquals(i, item))) {
        // Already present — promote to primary by moving to end.
        const filtered = current.filter((i) => !itemEquals(i, item));
        pushSet([...filtered, item]);
      } else {
        pushSet([...current, item]);
      }
    },
    [current, pushSet],
  );

  const remove = useCallback(
    (item: SelectionItem) => {
      const next = current.filter((i) => !itemEquals(i, item));
      pushSet(next);
    },
    [current, pushSet],
  );

  const toggle = useCallback(
    (item: SelectionItem) => {
      if (current.some((i) => itemEquals(i, item))) {
        pushSet(current.filter((i) => !itemEquals(i, item)));
      } else {
        pushSet([...current, item]);
      }
    },
    [current, pushSet],
  );

  const replace = useCallback(
    (item: SelectionItem | null) => {
      if (item === null) {
        pushSet([]);
      } else {
        pushSet([item]);
      }
    },
    [pushSet],
  );

  const clear = useCallback(() => pushSet([]), [pushSet]);

  const setItems = useCallback(
    (items: readonly SelectionItem[]) => pushSet(items),
    [pushSet],
  );

  const goBack = useCallback(() => {
    setState((prev) =>
      prev.cursor > 0 ? { ...prev, cursor: prev.cursor - 1 } : prev,
    );
  }, []);

  const goForward = useCallback(() => {
    setState((prev) =>
      prev.cursor < prev.entries.length - 1
        ? { ...prev, cursor: prev.cursor + 1 }
        : prev,
    );
  }, []);

  // Auto-add-player rule (§7.3). Fires when the set is empty in
  // player POV. Guarded by a ref so the auto-add itself doesn't
  // race against a real user click that empties the set.
  const lastAutoAddRef = useRef<number | null>(null);
  useEffect(() => {
    if (povApi === null) return;
    if (povApi.pov.kind !== "actor") return;
    if (current.length !== 0) return;
    const actorId = povApi.pov.actorId;
    if (lastAutoAddRef.current === actorId) return;
    lastAutoAddRef.current = actorId;
    pushSet([{ kind: "actor", id: actorId }]);
  }, [povApi, current.length, pushSet]);

  // Reset the auto-add latch whenever POV changes or set becomes
  // non-empty, so subsequent emptyings can re-trigger.
  useEffect(() => {
    if (current.length !== 0) lastAutoAddRef.current = null;
  }, [current.length]);
  useEffect(() => {
    lastAutoAddRef.current = null;
  }, [povApi?.pov]);

  const api = useMemo<SelectionSetApi>(
    () => ({
      items: current,
      primary: current.length === 0 ? null : current[current.length - 1]!,
      has,
      add,
      remove,
      toggle,
      replace,
      clear,
      setItems,
      setSelection: replace,
      goBack,
      goForward,
      canGoBack: state.cursor > 0,
      canGoForward: state.cursor < state.entries.length - 1,
    }),
    [
      current,
      has,
      add,
      remove,
      toggle,
      replace,
      clear,
      setItems,
      goBack,
      goForward,
      state.cursor,
      state.entries.length,
    ],
  );

  return <Ctx.Provider value={api}>{props.children}</Ctx.Provider>;
}

export function useSelectionSet(): SelectionSetApi {
  const ctx = useContext(Ctx);
  if (ctx === null) {
    throw new Error("useSelectionSet must be used inside <SelectionSetProvider>");
  }
  return ctx;
}
