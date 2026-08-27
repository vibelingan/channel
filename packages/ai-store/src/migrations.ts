import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const migrationDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

async function sqlFile(name: string): Promise<string> {
  return readFile(join(migrationDir, name), 'utf8');
}

export async function migrateUp(pool: Pool): Promise<void> {
  const exists = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('public.ai_schema_migrations') IS NOT NULL AS exists",
  );
  if (exists.rows[0]?.exists) {
    const applied = await pool.query<{ version: string }>(
      "SELECT version FROM ai_schema_migrations WHERE version = '001_ai_assistant'",
    );
    if (applied.rowCount === 1) return;
  }
  await pool.query(await sqlFile('001_ai_assistant.up.sql'));
}

export async function migrateDown(pool: Pool): Promise<void> {
  await pool.query(await sqlFile('001_ai_assistant.down.sql'));
}
