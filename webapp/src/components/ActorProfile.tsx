import { useMemo } from "react";
import type { DaySnapshot, RunDump, RunEvent } from "../types.js";
import type { Selection } from "../App.js";
import { Avatar } from "./Avatar.js";
import { ActorRef, ItemRef, PoolRef } from "./Refs.js";
import { colourFor, resolvePerceiverJ } from "../lib/palette.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly hour: number;
  readonly snapshot: DaySnapshot | null;
  readonly actorId: number;
  readonly onSelect?: ((s: Selection) => void) | undefined;
}

export function ActorProfile({
  dump,
  day,
  hour,
  snapshot,
  actorId,
  onSelect,
}: Props) {
  const actor = dump.actors.find((a) => a.id === actorId);
  if (actor === undefined) return null;
  const isPlayer = actor.id === dump.playerActorId;
  const isVirtual = actor.isVirtual === true;

  // Stage 6 — virtual external producer. They don't tick, hold no
  // stock, attend no deals. Render the compact "who-I-am" panel:
  // owned pools + the brokers who can reach them.
  if (isVirtual) {
    return (
      <VirtualActorProfile
        dump={dump}
        snapshot={snapshot}
        actor={actor}
        onSelect={onSelect}
      />
    );
  }

  const sa = snapshot?.actors.find((a) => a.id === actorId) ?? null;
  const cash = sa?.cash ?? actor.cash;
  const heat = sa?.heat ?? 0;
  // Resolve the actor's current location by replaying actor.travelled
  // events from the previous-day snapshot up to (and including) the
  // current hour — same logic the map uses, so the two views agree.
  // The dump's snapshot.currentLocationId is end-of-day state and gives
  // the wrong answer for any intra-day hour.
  const locId = useMemo<number | null>(() => {
    const startSnap =
      dump.snapshots?.find((s) => s.day === day - 1) ??
      dump.snapshots?.find((s) => s.day === day) ?? null;
    let loc: number | null;
    if (startSnap !== null) {
      const startActor = startSnap.actors.find((a) => a.id === actorId);
      loc = startActor ? startActor.currentLocationId : actor.currentLocationId;
    } else {
      loc = actor.currentLocationId;
    }
    for (const e of dump.events as readonly RunEvent[]) {
      if (e.at.day !== day) continue;
      if (e.at.hour > hour) break;
      if (e.type !== "actor.travelled") continue;
      if ((e.actorId as number) !== actorId) continue;
      loc = (e.toLocationId as number) ?? null;
    }
    return loc;
  }, [dump, day, hour, actorId, actor.currentLocationId]);

  const locName = (id: number | null) =>
    id === null
      ? "—"
      : dump.locations.find((l) => l.id === id)?.displayName ?? `loc ${id}`;

  const stockSummary = useMemo(() => {
    if (snapshot === null) return null;
    const lots = snapshot.stockLots.filter((l) => l.ownerActorId === actorId);
    const units = lots.reduce((s, l) => s + l.quantity, 0);
    const cost = lots.reduce((s, l) => s + l.quantity * l.acquiredUnitPrice, 0);
    return { lotCount: lots.length, units, cost };
  }, [snapshot, actorId]);

  const dealCounts = useMemo(() => {
    if (snapshot === null) return null;
    let openBuy = 0;
    let openSell = 0;
    let settled = 0;
    let defaulted = 0;
    for (const d of snapshot.deals) {
      const involved =
        d.buyerActorId === actorId || d.sellerActorId === actorId;
      if (!involved) continue;
      if (d.state === "agreed" && d.buyerActorId === actorId) openBuy += 1;
      else if (d.state === "agreed" && d.sellerActorId === actorId) openSell += 1;
      else if (d.state === "settled") settled += 1;
      else if (d.state === "defaulted") defaulted += 1;
    }
    return { openBuy, openSell, settled, defaulted };
  }, [snapshot, actorId]);

  const reachablePools = useMemo(() => {
    if (snapshot === null) return 0;
    return snapshot.pools.filter(
      (p) =>
        p.flushedDay === null &&
        p.expiryDay >= day &&
        p.createdDay <= day &&
        p.reachableBy.includes(actorId),
    ).length;
  }, [snapshot, day, actorId]);

  // Stage 7 — cash-in-transit (off-map resale revenue arriving with a
  // lag). Only shown when non-zero; mostly relevant to whales.
  const pendingPayoutTotal = useMemo(() => {
    if (snapshot === null) return 0;
    return (snapshot.pendingPayouts ?? [])
      .filter((p) => p.actorId === actorId)
      .reduce((sum, p) => sum + p.amount, 0);
  }, [snapshot, actorId]);

  return (
    <section className="actor-profile">
      <header className="profile-head">
        <Avatar
          name={actor.displayName}
          code={actor.code}
          isPlayer={isPlayer}
          size={42}
        />
        <div className="profile-title">
          <div className="profile-name">
            {isPlayer ? "▶ " : ""}
            {actor.displayName}
          </div>
          <div className="profile-code muted">
            {actor.code} · {actor.transportCapacity}
          </div>
        </div>
      </header>
      <dl className="profile-stats">
        <dt>Cash</dt>
        <dd>£{cash}</dd>
        <dt>Home</dt>
        <dd>{locName(actor.homeLocationId)}</dd>
        <dt>Now at</dt>
        <dd>{locName(locId)}</dd>
        <dt>Heat</dt>
        <dd className={heat > 0 ? "warn" : "muted"}>{heat > 0 ? `🔥 ${heat}` : "—"}</dd>
        {stockSummary !== null ? (
          <>
            <dt>Stock</dt>
            <dd>
              {stockSummary.units} units{" "}
              <span className="muted">
                ({stockSummary.lotCount} lot{stockSummary.lotCount === 1 ? "" : "s"} · £{stockSummary.cost} cost)
              </span>
            </dd>
          </>
        ) : null}
        {dealCounts !== null ? (
          <>
            <dt>Open deals</dt>
            <dd>
              {dealCounts.openBuy + dealCounts.openSell === 0 ? (
                <span className="muted">—</span>
              ) : (
                <>
                  {dealCounts.openBuy > 0 ? <>buying {dealCounts.openBuy}</> : null}
                  {dealCounts.openBuy > 0 && dealCounts.openSell > 0 ? " · " : ""}
                  {dealCounts.openSell > 0 ? <>selling {dealCounts.openSell}</> : null}
                </>
              )}
            </dd>
            <dt>Closed</dt>
            <dd>
              <span className="muted">{dealCounts.settled} settled</span>
              {dealCounts.defaulted > 0 ? (
                <>
                  {" · "}
                  <span className="warn">{dealCounts.defaulted} defaulted</span>
                </>
              ) : null}
            </dd>
          </>
        ) : null}
        <dt>Reachable pools</dt>
        <dd>{reachablePools}</dd>
        {actor.socialScore !== undefined ? (
          <>
            <dt
              title="Character arm — how easily this actor reads tells and conceals dodginess. Modifies flaw-detection at pub-deal entry."
            >
              Social
            </dt>
            <dd>
              <span
                className={`badge palette-stop-${colourFor(actor.socialScore, resolvePerceiverJ(dump), { invert: isPlayer })}`}
                title={`social score ${actor.socialScore.toFixed(2)}`}
              >
                {actor.socialScore.toFixed(2)}
              </span>
            </dd>
          </>
        ) : null}
        {pendingPayoutTotal > 0 ? (
          <>
            <dt>In transit</dt>
            <dd className="muted">£{pendingPayoutTotal}</dd>
          </>
        ) : null}
      </dl>
      {actor.bidderProfile !== undefined ? (
        <ExpertiseSection
          profile={actor.bidderProfile}
          perceiverJ={resolvePerceiverJ(dump)}
          invert={isPlayer}
        />
      ) : null}
    </section>
  );
}

/**
 * Per-category expertise indicator surfaced from the actor's
 * bidderProfile. Shows what categories they're sharp on (their
 * specialties), their general competence floor, the flaw types they
 * notice, and the customer market they serve.
 *
 * Colour is now driven by the judgement palette (docs/judgement.md
 * "Display — band-collapsed colour palette"): a 10-stop blue→green→
 * red ramp where high accuracy ≈ red. Crucially, *which* stops the
 * UI distinguishes is gated by the player-actor's j — playing Trigger
 * (j ≈ 0.3) collapses the screen to 3 visible bands, so a "Boyce is
 * sharp" chip might be indistinguishable from "Boyce is okay-ish."
 * That's the cinematic intent: low-j characters force the human to
 * compensate via notes and memory.
 */
function ExpertiseSection({
  profile,
  perceiverJ,
  invert,
}: {
  readonly profile: NonNullable<RunDump["actors"][number]["bidderProfile"]>;
  readonly perceiverJ: number;
  /** Flip the palette so high competence reads blue (good for the
   *  actor being described) — passed in when the profile belongs to
   *  the player's actor. Other actors' profiles stay value-monotonic
   *  so their high competence reads red (bad for the player as a
   *  potential counterparty). */
  readonly invert: boolean;
}) {
  const categories = useMemo(() => {
    const entries = Object.entries(profile.appraisalAccuracy ?? {});
    // Surface every named category, ranked by accuracy desc. The
    // viewer can read the gap between named-category accuracy and
    // the actor's `defaultAppraisalAccuracy` to see who's a
    // specialist vs a generalist.
    return entries
      .map(([cat, acc]) => ({ category: cat, accuracy: acc }))
      .sort((a, b) => b.accuracy - a.accuracy);
  }, [profile]);

  const flaws = useMemo(() => {
    const entries = Object.entries(profile.flawTypeDetection ?? {});
    const def = profile.defaultFlawTypeDetection ?? 0;
    // Only list flaws where the actor is *better than their own
    // default* — the design hook is "what flaws do they have an
    // eye for?", not "what's their flat detection score."
    return entries
      .filter(([, det]) => det > def + 0.05)
      .map(([flaw, det]) => ({ flaw, detection: det }))
      .sort((a, b) => b.detection - a.detection);
  }, [profile]);

  const defaultAccuracy = profile.defaultAppraisalAccuracy ?? 0.5;

  // Don't render the section if the actor is a featureless generalist
  // with no specialties and no flaw eye — there's nothing to surface.
  if (
    categories.length === 0 &&
    flaws.length === 0 &&
    (profile.customerTypes?.length ?? 0) === 0
  ) {
    return null;
  }

  return (
    <section className="profile-expertise">
      <div className="profile-section-label">Expertise</div>
      <dl className="profile-stats">
        {categories.length > 0 ? (
          <>
            <dt>Sharp on</dt>
            <dd>
              <ul className="profile-inline-list expertise-list">
                {categories.map((c) => (
                  <li key={c.category}>
                    <ExpertiseChip
                      label={c.category}
                      accuracy={c.accuracy}
                      perceiverJ={perceiverJ}
                      invert={invert}
                    />
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        <dt>General eye</dt>
        <dd>
          <span
            className={`badge palette-stop-${colourFor(defaultAccuracy, perceiverJ, { invert })}`}
            title={`accuracy ${defaultAccuracy.toFixed(2)}`}
          >
            {defaultAccuracy.toFixed(2)}
          </span>
        </dd>
        {flaws.length > 0 ? (
          <>
            <dt>Eye for flaws</dt>
            <dd>
              <ul className="profile-inline-list expertise-list">
                {flaws.map((f) => (
                  <li key={f.flaw}>
                    <ExpertiseChip
                      label={f.flaw}
                      accuracy={f.detection}
                      perceiverJ={perceiverJ}
                    />
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        {profile.customerTypes !== undefined && profile.customerTypes.length > 0 ? (
          <>
            <dt>Sells to</dt>
            <dd>
              <ul className="profile-inline-list expertise-list">
                {profile.customerTypes.map((t) => (
                  <li key={t}>
                    <span className="badge badge-market">{t}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

function ExpertiseChip({
  label,
  accuracy,
  perceiverJ,
  invert,
}: {
  readonly label: string;
  readonly accuracy: number;
  readonly perceiverJ: number;
  readonly invert: boolean;
}) {
  return (
    <span
      className={`badge palette-stop-${colourFor(accuracy, perceiverJ, { invert })}`}
      title={`${label} · accuracy ${accuracy.toFixed(2)}`}
    >
      {label}
    </span>
  );
}

function VirtualActorProfile({
  dump,
  snapshot,
  actor,
  onSelect,
}: {
  readonly dump: RunDump;
  readonly snapshot: DaySnapshot | null;
  readonly actor: RunDump["actors"][number];
  readonly onSelect?: ((s: Selection) => void) | undefined;
}) {
  const ownedPools = useMemo(() => {
    if (snapshot === null) return [];
    return snapshot.pools.filter(
      (p) => p.ownerActorId === actor.id && p.flushedDay === null,
    );
  }, [snapshot, actor.id]);

  // Union of brokers across this producer's currently-live owned pools.
  // The Stage 6 design treats the broker set as a per-producer property
  // even though it's stored per-pool, so this groups cleanly.
  const brokerIds = useMemo(() => {
    const s = new Set<number>();
    for (const p of ownedPools) {
      for (const aid of p.reachableBy) s.add(aid);
    }
    return [...s].sort((a, b) => a - b);
  }, [ownedPools]);

  // Provenance phrases used across this producer's live pools — duplicates
  // are dropped so the panel reads as a phrase bank, not a duplicate list.
  const phrases = useMemo(() => {
    const s = new Set<string>();
    for (const p of ownedPools) {
      if (p.provenance) s.add(p.provenance);
    }
    return [...s];
  }, [ownedPools]);

  return (
    <section className="actor-profile actor-profile-virtual">
      <header className="profile-head">
        <Avatar
          name={actor.displayName}
          code={actor.code}
          isPlayer={false}
          size={42}
        />
        <div className="profile-title">
          <div className="profile-name">{actor.displayName}</div>
          <div className="profile-code muted">
            {actor.code} ·{" "}
            <span className="badge badge-virtual">virtual producer</span>
          </div>
        </div>
      </header>
      <dl className="profile-stats">
        <dt>Live pools</dt>
        <dd>
          {ownedPools.length === 0 ? (
            <span className="muted">—</span>
          ) : (
            <ul className="profile-inline-list">
              {ownedPools.map((p) => (
                <li key={p.id}>
                  {onSelect !== undefined ? (
                    <PoolRef
                      dump={dump}
                      id={p.id}
                      onSelect={onSelect}
                      variant="chip"
                    />
                  ) : (
                    <span>pool {p.id}</span>
                  )}{" "}
                  <span className="muted">
                    {p.quantityRemaining}×{" "}
                  </span>
                  <ItemRef
                    dump={dump}
                    id={p.itemKindId}
                    onSelect={onSelect ?? (() => {})}
                    variant="chip"
                    qualityTier={p.qualityTier}
                  />
                </li>
              ))}
            </ul>
          )}
        </dd>
        {brokerIds.length > 0 ? (
          <>
            <dt>Brokers</dt>
            <dd>
              <ul className="profile-inline-list">
                {brokerIds.map((aid) => (
                  <li key={aid}>
                    {onSelect !== undefined ? (
                      <ActorRef
                        dump={dump}
                        id={aid}
                        onSelect={onSelect}
                        variant="chip"
                        size={16}
                      />
                    ) : (
                      <span>actor {aid}</span>
                    )}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        {phrases.length > 0 ? (
          <>
            <dt>Provenance</dt>
            <dd className="muted">
              {phrases.map((s, i) => (
                <div key={i}>"{s}"</div>
              ))}
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}
