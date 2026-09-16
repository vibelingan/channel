import type { Pool } from 'pg';

/**
 * What a passing readiness check actually established about the store.
 *
 * `select 1` is not enough: it also succeeds against a read-only replica, and
 * against a role that cannot open a transaction. LLD-001's whole consistency
 * argument rests on transactions rolling back and on READ COMMITTED, so
 * readiness proves those two things directly.
 */
export type StoreProof = {
  readonly txn: 'proven';
  readonly isolation: string;
};

/** The scratch table is temporary, so it is per-connection and needs no migration. */
const PROBE_TABLE = 'ai_readiness_probe';

export async function proveStore(pool: Pool): Promise<StoreProof> {
  // Every step runs on ONE checked-out connection: a temporary table belongs to
  // the session that made it, so a pool round-robin mid-proof would not see it.
  const client = await pool.connect();
  try {
    const isolation = (await client.query('show transaction_isolation')).rows[0]
      .transaction_isolation as string;
    if (isolation !== 'read committed') {
      throw new Error(`store is at "${isolation}"; LLD-001 §4.4 requires read committed`);
    }

    await client.query(
      `create temp table if not exists ${PROBE_TABLE} (n int) on commit preserve rows`,
    );
    await client.query(`truncate ${PROBE_TABLE}`);

    await client.query('begin');
    try {
      await client.query(`insert into ${PROBE_TABLE} (n) values (1)`);
      const inside = await client.query(`select count(*)::int as n from ${PROBE_TABLE}`);
      if (inside.rows[0].n !== 1) {
        throw new Error('a write was not visible inside its own transaction');
      }
      await client.query('rollback');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    }

    const after = await client.query(`select count(*)::int as n from ${PROBE_TABLE}`);
    if (after.rows[0].n !== 0) {
      throw new Error('rollback did not discard the write');
    }

    return { txn: 'proven', isolation };
  } finally {
    // Releasing with `true` discards the connection, taking the temp table with
    // it. The proof leaves the store exactly as it found it.
    client.release(true);
  }
}

export type StoreReadiness = {
  check(): Promise<StoreProof>;
};

/**
 * Proves the store once, then keeps the verdict. Later checks only confirm the
 * store is still reachable — re-running the full proof on every poll would put
 * a transaction on the database for every readiness probe a platform sends.
 *
 * A failure is never cached: a store that is down at boot must be able to
 * become ready without a restart, or a transient outage becomes a crash loop.
 */
export function createStoreReadiness(pool: Pool): StoreReadiness {
  let proof: StoreProof | null = null;
  let inFlight: Promise<StoreProof> | null = null;

  return {
    async check(): Promise<StoreProof> {
      if (proof) {
        await pool.query('select 1');
        return proof;
      }
      inFlight ??= proveStore(pool)
        .then((result) => {
          proof = result;
          return result;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
