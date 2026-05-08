import type { DB } from "./db.js";

export interface Migration {
  /** Monotonic version. The first applied migration is version 1. */
  readonly version: number;
  /** Human-readable name, recorded for debugging. */
  readonly name: string;
  /** Apply the migration. Runs inside a transaction. */
  up(db: DB): void;
}

const ENSURE_VERSION_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    name    TEXT    NOT NULL,
    applied_at_ms INTEGER NOT NULL
  );
`;

/**
 * Apply any migrations whose version is greater than the highest version
 * currently recorded in `schema_version`. Migrations must be passed in
 * ascending version order with no gaps; mis-ordered or duplicate versions
 * throw.
 */
export function applyMigrations(db: DB, migrations: readonly Migration[]): void {
  db.exec(ENSURE_VERSION_TABLE);

  validateMigrationOrder(migrations);

  const currentVersionRow = db
    .prepare<{ v: number | null }>("SELECT MAX(version) AS v FROM schema_version")
    .get();
  const currentVersion = currentVersionRow?.v ?? 0;

  const recordStmt = db.prepare(
    "INSERT INTO schema_version (version, name, applied_at_ms) VALUES (@version, @name, @applied_at_ms)",
  );

  for (const m of migrations) {
    if (m.version <= currentVersion) continue;
    db.transaction(() => {
      m.up(db);
      recordStmt.run({
        version: m.version,
        name: m.name,
        applied_at_ms: Date.now(),
      });
    });
  }
}

function validateMigrationOrder(migrations: readonly Migration[]): void {
  let expected = 1;
  for (const m of migrations) {
    if (m.version !== expected) {
      throw new Error(
        `migrations must be sequential from 1; got version ${m.version} where ${expected} was expected`,
      );
    }
    expected += 1;
  }
}
