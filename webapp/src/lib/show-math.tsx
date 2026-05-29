import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usePov } from "./pov.js";

/**
 * "Show the math" toggle (docs/judgement.md — "show-judgement-numerics
 * dev-mode toggle"). Controls whether NPC↔NPC judgement hovers
 * surface raw numbers or just the formula structure.
 *
 * Design intent:
 *   • Admin POV — always reveal (omniscient lens).
 *   • Player POV reading their own appraisal — always reveal
 *     (self-appraisal is a thing you can introspect on).
 *   • Player POV reading another actor's appraisal — hide by default
 *     (you don't know the exact numbers in their head), unless the
 *     toggle is on (dev mode).
 *
 * The toggle is persisted in localStorage so a dev who turns it on
 * keeps it on across reload.
 */

export interface ShowMathApi {
  readonly showMath: boolean;
  readonly setShowMath: (v: boolean) => void;
  /** Resolve the reveal decision for a hover where `observerActorId`
   *  is the actor whose appraisal we're rendering. Combines the
   *  toggle with the POV-based default. */
  readonly revealNumerics: (observerActorId: number | null) => boolean;
}

const Ctx = createContext<ShowMathApi | null>(null);

const STORAGE_KEY = "trader-show-math";

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStored(v: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
  } catch {
    /* quota / disabled */
  }
}

export function ShowMathProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const [showMath, setShowMathState] = useState<boolean>(() => readStored());
  const { pov } = usePov();

  const setShowMath = useCallback((v: boolean) => {
    setShowMathState(v);
    writeStored(v);
  }, []);

  useEffect(() => {
    document.documentElement.dataset["showMath"] = showMath ? "1" : "0";
    return () => {
      delete document.documentElement.dataset["showMath"];
    };
  }, [showMath]);

  const revealNumerics = useCallback(
    (observerActorId: number | null): boolean => {
      if (showMath) return true;
      if (pov.kind === "admin") return true;
      if (observerActorId !== null && pov.actorId === observerActorId) return true;
      return false;
    },
    [showMath, pov],
  );

  const api = useMemo<ShowMathApi>(
    () => ({ showMath, setShowMath, revealNumerics }),
    [showMath, setShowMath, revealNumerics],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useShowMath(): ShowMathApi {
  const ctx = useContext(Ctx);
  if (ctx === null) {
    throw new Error("useShowMath must be used inside a <ShowMathProvider>");
  }
  return ctx;
}
