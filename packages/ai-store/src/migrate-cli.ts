import { Pool } from 'pg';
import { migrateDown, migrateUp } from './migrations.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  throw new Error('usage: migrate-cli.ts <up|down>');
}

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
try {
  if (direction === 'up') await migrateUp(pool);
  else await migrateDown(pool);
} finally {
  await pool.end();
}
