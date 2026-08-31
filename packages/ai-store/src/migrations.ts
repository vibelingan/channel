import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const migrationDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

async function sqlFile(name: string): Promise<string> {
  return readFile(join(migrationDir, name), 'utf8');
}

/**
 * Ordered, and each file records its own version inside its transaction.
 *
 * The previous runner knew one migration by name and returned early once it was
 * applied, so adding a second one would have been silently skipped on every
 * database that already had the first — the schema would diverge from the code
 * with nothing reporting it.
 */
export const MIGRATIONS = ['001_ai_assistant', '002_engine_provenance'] as const;

export async function migrateUp(pool: Pool): Promise<void> {
  const exists = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('public.ai_schema_migrations') IS NOT NULL AS exists",
  );
  const applied = new Set<string>();
  if (exists.rows[0]?.exists) {
    const rows = await pool.query<{ version: string }>('SELECT version FROM ai_schema_migrations');
    for (const row of rows.rows) applied.add(row.version);
  }
  for (const version of MIGRATIONS) {
    if (applied.has(version)) continue;
    await pool.query(await sqlFile(`${version}.up.sql`));
  }
}

export async function migrateDown(pool: Pool): Promise<void> {
  for (const version of [...MIGRATIONS].reverse()) {
    await pool.query(await sqlFile(`${version}.down.sql`));
  }
}
