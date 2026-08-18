/**
 * The PostgreSQL connection pool for the AI assistant's operational store.
 *
 * Its one opinionated job: guarantee that every connection this application
 * uses runs at READ COMMITTED, because LLD-001 §4.4 depends on a specific
 * behaviour that only holds there.
 */

import { Pool, type PoolClient, type PoolConfig } from 'pg';

/**
 * Passed to the backend in the connection startup packet, so the level is in
 * force before the first query rather than set by one. The backslash escapes
 * the space inside the value, which is libpq's syntax, not ours.
 */
const ISOLATION_OPTION = '-c default_transaction_isolation=read\\ committed';

export interface AiPoolConfig extends PoolConfig {
  connectionString: string;
}

/**
 * Create the pool.
 *
 * `SET SESSION CHARACTERISTICS` on every new connection is deliberate and is
 * not belt-and-braces. LLD-001's fence is a conditional `UPDATE ... RETURNING`
 * that must return ZERO ROWS when it waited on a row lock and the predicate has
 * since become false. That is READ COMMITTED behaviour. Above it, PostgreSQL
 * raises a serialization failure instead — so "a salesperson took over first"
 * would surface to the visitor as a 500 rather than a clean conflict.
 *
 * We set it rather than trust the server default because the default is a
 * property of the deployment, not of our code: a managed provider or a pooler
 * can ship something else, and the store probe (S1) treats a different default
 * as a finding precisely because it is not ours to assume.
 *
 * It is sent as a startup parameter rather than issued as a `SET` from a
 * `connect` listener. A listener cannot be awaited by the pool, so its `SET`
 * only lands first because `pg` happens to queue queries on a busy client —
 * behaviour `pg` has deprecated and will remove in v9. Startup parameters have
 * no such race and no such expiry date.
 */
export function createAiPool(config: AiPoolConfig): Pool {
  return new Pool({
    ...config,
    application_name: config.application_name ?? 'channel-ai',
    options: config.options ? `${config.options} ${ISOLATION_OPTION}` : ISOLATION_OPTION,
  });
}

/**
 * Run `fn` inside one transaction, committing on return and rolling back on
 * throw.
 *
 * The rollback path is load-bearing beyond tidiness: LLD-001 §8's gapless event
 * sequence works *because* an aborted transaction un-does its counter bump. A
 * helper that swallowed a failed rollback would silently break that invariant,
 * so a rollback failure is surfaced rather than logged.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let destroyed = false;
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch (rollbackError) {
      // Destroy the connection instead of returning it. A rollback that failed
      // leaves the session in an unknown state — possibly still inside the
      // transaction — and the next borrower would inherit it.
      client.release(rollbackError as Error);
      destroyed = true;
      // Report both, so the original failure is not hidden behind the cleanup.
      throw new AggregateError([error, rollbackError], 'transaction failed and rollback failed');
    }
    throw error;
  } finally {
    if (!destroyed) client.release();
  }
}
