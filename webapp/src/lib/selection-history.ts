import { useCallback, useState } from "react";
import type { Selection } from "../App.js";

const MAX_HISTORY = 100;

interface HistoryState {
  readonly entries: readonly (Selection | null)[];
  /** Index into `entries` of the currently-displayed selection. */
  readonly cursor: number;
}

export interface SelectionHistoryAPI {
  readonly selection: Selection | null;
  readonly setSelection: (s: Selection | null) => void;
  readonly goBack: () => void;
  readonly goForward: () => void;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

function selectionEquals(
  a: Selection | null,
  b: Selection | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.kind === b.kind && a.id === b.id;
}

/**
 * Browser-style back/forward navigation over selection state. Each
 * `setSelection` push truncates any "forward" history (matching the
 * browser model — going back then making a new choice forks the
 * timeline). Consecutive duplicate selections are coalesced. The list
 * caps at MAX_HISTORY and trims oldest first.
 */
export function useSelectionHistory(
  initial: Selection | null = null,
): SelectionHistoryAPI {
  const [state, setState] = useState<HistoryState>({
    entries: [initial],
    cursor: 0,
  });

  const setSelection = useCallback((next: Selection | null) => {
    setState((prev) => {
      const current = prev.entries[prev.cursor] ?? null;
      if (selectionEquals(current, next)) return prev;
      // Truncate forward history; append new entry; trim from start if
      // we've outgrown the cap.
      const kept = prev.entries.slice(0, prev.cursor + 1);
      const appended = [...kept, next];
      const overflow = appended.length - MAX_HISTORY;
      const trimmed = overflow > 0 ? appended.slice(overflow) : appended;
      return { entries: trimmed, cursor: trimmed.length - 1 };
    });
  }, []);

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

  return {
    selection: state.entries[state.cursor] ?? null,
    setSelection,
    goBack,
    goForward,
    canGoBack: state.cursor > 0,
    canGoForward: state.cursor < state.entries.length - 1,
  };
}
