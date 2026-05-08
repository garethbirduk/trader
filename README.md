# trader-engine

A skin-agnostic simulation engine for buy-low / sell-high trading games. The
engine models a living market: world supply pools, autonomous NPC actors,
forward-sold deals with deadlines, an information ledger of leads and trust,
and an auction house that catches anything that doesn't clear privately. The
player is just one actor among many, so the world runs whether anyone is
watching or not.

The engine is designed to be reskinned. The first two intended skins are
*Only Fools and Horses* and *Minder*, but nothing in the engine references
either show.

## Status

Pre-alpha. See `docs/` for the design notes and the milestone plan.

## Build

```sh
npm install
npm test
```

## Layout

```
src/engine/         Core engine: clock, db, types, stock, deals, etc.
src/mechanics/      Pluggable interaction modules.
src/skins/          Content packs (item kinds, actors, locations, prices).
src/drivers/        ActorPolicy + NegotiationDriver implementations.
src/headless/       CLI runner for self-running simulations.
tests/              Invariant + scenario tests.
```
