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
src/engine/             Core engine: clock, db, types, stock, deals, etc.
src/engine/mechanics/   Pluggable interaction modules.
src/skins/              Content packs (item kinds, actors, locations, prices).
src/headless/           CLI runner for self-running simulations.
tests/                  Invariant + scenario tests.
webapp/                 React viewer (static and live modes).
```

## Hosting

The webapp ships in two modes:

- **Static mode** (default): the page loads a pre-baked `events.json`
  produced by the headless sim. Cheap to host — the whole thing is a
  static bundle. Default behavior at `/`.
- **Live mode**: the engine runs in the browser via sql.js (SQLite
  compiled to WebAssembly). Activated with `?mode=live` — supports
  `?seed=foo&days=N`. The engine code is code-split so static-mode
  visitors don't pay for it.

The same DB interface (`src/engine/core/db.ts`) backs both: Node uses
`db-better-sqlite3.ts` (native), browser uses `db-sqljs.ts` (WASM).
Engine code on top is driver-agnostic; the entry point picks.

### Local

```sh
npm install
npm run sim -- --quiet --out webapp/public/events.json
cd webapp && npm install && npm run dev
```

Open http://localhost:5173/ for static mode or
http://localhost:5173/?mode=live&seed=test&days=5 for live mode.

### GitHub Pages

`.github/workflows/deploy.yml` runs the sim, builds the webapp with
`BASE_URL=/trader/`, and deploys `webapp/dist/` to GitHub Pages on
every push to `main`. To use it on a fork, enable Pages in the repo
settings (source: GitHub Actions) and update `BASE_URL` to match your
repo name.
