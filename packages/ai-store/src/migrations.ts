import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

const migrationDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const migrationLockName = 'channel-ai-schema-migrations';

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
export const MIGRATIONS = [
  '001_ai_assistant',
  '002_engine_provenance',
  '003_git_config_provenance',
] as const;

async function withMigrationLock(
  pool: Pool,
  operation: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query(
      'SELECT pg_advisory_lock(hashtext(current_database()), hashtext($1::text))',
      [migrationLockName],
    );
    locked = true;
    await operation(client);
  } finally {
    try {
      if (locked) {
        await client.query(
          'SELECT pg_advisory_unlock(hashtext(current_database()), hashtext($1::text))',
          [migrationLockName],
        );
      }
    } finally {
      client.release();
    }
  }
}

export async function migrateUp(pool: Pool): Promise<void> {
  await withMigrationLock(pool, async (client) => {
    const exists = await client.query<{ exists: boolean }>(
      "SELECT to_regclass('public.ai_schema_migrations') IS NOT NULL AS exists",
    );
    const applied = new Set<string>();
    if (exists.rows[0]?.exists) {
      const rows = await client.query<{ version: string }>(
        'SELECT version FROM ai_schema_migrations',
      );
      for (const row of rows.rows) applied.add(row.version);
    }
    for (const version of MIGRATIONS) {
      if (applied.has(version)) continue;
      await client.query(await sqlFile(`${version}.up.sql`));
    }
  });
}

export async function migrateDown(pool: Pool): Promise<void> {
  await withMigrationLock(pool, async (client) => {
    for (const version of [...MIGRATIONS].reverse()) {
      await client.query(await sqlFile(`${version}.down.sql`));
    }
  });
}
