import { createContext, useContext, type ReactNode } from "react";

/**
 * Lightweight context for the viewer's "current day/hour" so leaf
 * components (e.g. <LocationRef variant="chip">) can resolve
 * time-dependent state — open/closed, busy/empty — without every
 * caller threading day+hour through. The App's <Loaded> wraps its
 * content in this provider with its day/hour state.
 *
 * Default value is day=1/hour=0 so static unit tests / Storybook-y
 * uses don't need to wrap.
 */
export interface CurrentTime {
  readonly day: number;
  readonly hour: number;
}

const Ctx = createContext<CurrentTime>({ day: 1, hour: 0 });

export function CurrentTimeProvider({
  value,
  children,
}: {
  readonly value: CurrentTime;
  readonly children: ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCurrentTime(): CurrentTime {
  return useContext(Ctx);
}
