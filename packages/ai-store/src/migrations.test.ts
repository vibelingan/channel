/**
 * The services apply these migrations themselves at startup, connected as the
 * application's own database account: a normal account on TencentDB, not the
 * instance administrator. Tencent documents extension installs for its
 * superuser-type account and says nothing about normal accounts, so a migration
 * that installs one could stop both services from starting in production while
 * passing everywhere else, because CI and local development connect as a
 * PostgreSQL superuser.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const migrationDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

test('no migration installs a PostgreSQL extension', () => {
  const files = readdirSync(migrationDir).filter((name) => name.endsWith('.up.sql'));
  assert.ok(files.length > 0, 'no up migrations found');
  for (const name of files) {
    const sql = readFileSync(join(migrationDir, name), 'utf8');
    assert.doesNotMatch(
      sql,
      /\bcreate\s+extension\b/i,
      `${name} installs an extension; the application account may not be allowed to`,
    );
  }
});
