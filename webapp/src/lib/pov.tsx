import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { RunActor, RunDump } from "../types.js";
import { getActorColor } from "../avatar.js";
import { fullName } from "./actor-names.js";

/**
 * POV — "through whose eyes am I looking" (docs/ui.md §2.1). A
 * persistent header control. Admin = omniscient lens; actor = the
 * perceptual lens for that character.
 *
 * Per the doc: switching POV does NOT change engine state. It relenses
 * the player-facing panels. Components opt in to consuming this — the
 * provider just broadcasts; today's components ignore it until Phase 5.
 *
 * Default-on-boot at implementation time is Admin (debugging-first).
 * Sticky across reload via localStorage.
 */

export type Pov =
  | { readonly kind: "admin" }
  | { readonly kind: "actor"; readonly actorId: number };

export interface PovApi {
  readonly pov: Pov;
  readonly setPov: (p: Pov) => void;
  /** Resolved actor object when pov.kind === "actor", else null. */
  readonly actor: RunActor | null;
  /** Visual accent — actor colour for player POV, null for admin. */
  readonly accent: string | null;
  /** Human label: "Admin" or actor displayName. */
  readonly label: string;
}

const Ctx = createContext<PovApi | null>(null);

const STORAGE_KEY = "trader-pov";

function readStoredPov(): Pov | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as { kind?: unknown; actorId?: unknown };
    if (obj.kind === "admin") return { kind: "admin" };
    if (obj.kind === "actor" && typeof obj.actorId === "number") {
      return { kind: "actor", actorId: obj.actorId };
    }
    return null;
  } catch {
    return null;
  }
}

function writeStoredPov(pov: Pov): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pov));
  } catch {
    /* quota / disabled */
  }
}

export function PovProvider({
  dump,
  children,
}: {
  readonly dump: RunDump;
  readonly children: ReactNode;
}) {
  const [pov, setPovState] = useState<Pov>(() => {
    const stored = readStoredPov();
    if (stored === null) return { kind: "admin" };
    if (stored.kind === "actor") {
      const exists = dump.actors.some((a) => a.id === stored.actorId);
      if (!exists) return { kind: "admin" };
    }
    return stored;
  });

  const setPov = useCallback((next: Pov) => {
    setPovState(next);
    writeStoredPov(next);
  }, []);

  const actor = useMemo<RunActor | null>(() => {
    if (pov.kind !== "actor") return null;
    return dump.actors.find((a) => a.id === pov.actorId) ?? null;
  }, [pov, dump.actors]);

  const accent = useMemo<string | null>(() => {
    if (actor === null) return null;
    return getActorColor({
      code: actor.code,
      isPlayer: actor.id === dump.playerActorId,
    });
  }, [actor, dump.playerActorId]);

  const label = useMemo<string>(() => {
    if (pov.kind === "admin") return "Admin";
    return actor !== null ? fullName(actor) : "Unknown";
  }, [pov, actor]);

  useEffect(() => {
    const root = document.documentElement;
    if (accent === null) {
      root.style.removeProperty("--pov-accent");
      root.dataset["pov"] = "admin";
    } else {
      root.style.setProperty("--pov-accent", accent);
      root.dataset["pov"] = "actor";
    }
    return () => {
      root.style.removeProperty("--pov-accent");
      delete root.dataset["pov"];
    };
  }, [accent]);

  const api = useMemo<PovApi>(
    () => ({ pov, setPov, actor, accent, label }),
    [pov, setPov, actor, accent, label],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function usePov(): PovApi {
  const ctx = useContext(Ctx);
  if (ctx === null) {
    throw new Error("usePov must be used inside a <PovProvider>");
  }
  return ctx;
}

/**
 * Lookup-only variant — returns null outside a provider. Useful for
 * leaf components that want to lens themselves when POV is available
 * but render fine without it (e.g. unit tests, isolated stories).
 */
export function usePovOptional(): PovApi | null {
  return useContext(Ctx);
}
