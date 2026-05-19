import type { DB } from "../core/db.js";
import { persistKnowledgeProfile } from "./skills-repo.js";
import type { KnowledgeProfile } from "./types.js";

/**
 * Seed actor_skills + actor_skill_defaults for every actor in the
 * supplied map. Idempotent: re-running with the same map overwrites
 * the same rows.
 *
 * The map is the skin's authored knowledge data — the old two-axis
 * BidderProfile + `deriveKnowledgeProfile` fan-out is gone; skins now
 * author the five-axis shape directly.
 */
export function seedKnowledgeProfiles(
  db: DB,
  profiles: ReadonlyMap<number, KnowledgeProfile>,
): void {
  for (const [actorId, profile] of profiles) {
    persistKnowledgeProfile(db, actorId, profile);
  }
}
