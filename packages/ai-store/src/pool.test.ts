import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createAiPool, withTransaction } from './pool.ts';

const URL = process.env.DATABASE_URL ?? 'postgres://ai:ai@localhost:55432/ai_assistant';

test('every pooled connection reports READ COMMITTED', async () => {
  // LLD-001 §4.4: the design needs a conditional UPDATE that returns zero rows
  // on a lost fence. Above READ COMMITTED it raises a serialization error
  // instead, turning "someone else took over first" into a 500. The pool
  // asserts the level rather than inheriting whatever a pooler defaults to.
  const pool = createAiPool({ connectionString: URL, max: 3 });
  try {
    const levels = await Promise.all(
      [1, 2, 3].map(async () => {
        const c = await pool.connect();
        try {
          return (await c.query('show transaction_isolation')).rows[0].transaction_isolation;
        } finally {
          c.release();
        }
      }),
    );
    assert.deepEqual(levels, ['read committed', 'read committed', 'read committed']);
  } finally {
    await pool.end();
  }
});

test('withTransaction commits on success and rolls back on throw', async () => {
  const pool = createAiPool({ connectionString: URL });
  try {
    await pool.query('drop table if exists ai_store_probe');
    await pool.query('create table ai_store_probe (id int primary key, n int not null)');
    await pool.query('insert into ai_store_probe values (1, 0)');

    await withTransaction(pool, async (tx) => {
      await tx.query('update ai_store_probe set n = 1 where id = 1');
    });
    assert.equal((await pool.query('select n from ai_store_probe where id=1')).rows[0].n, 1);

    await assert.rejects(
      withTransaction(pool, async (tx) => {
        await tx.query('update ai_store_probe set n = 99 where id = 1');
        throw new Error('boom');
      }),
      /boom/,
    );
    // The rollback matters beyond tidiness: LLD-001 §8's gapless sequence
    // depends on an aborted transaction un-doing its counter bump.
    assert.equal((await pool.query('select n from ai_store_probe where id=1')).rows[0].n, 1);
  } finally {
    await pool.query('drop table if exists ai_store_probe');
    await pool.end();
  }
});

test('a conditional UPDATE that misses returns zero rows, not an error', async () => {
  const pool = createAiPool({ connectionString: URL });
  try {
    await pool.query('drop table if exists ai_store_probe2');
    await pool.query('create table ai_store_probe2 (id int primary key, epoch int not null)');
    await pool.query('insert into ai_store_probe2 values (1, 1)');
    const miss = await pool.query(
      'update ai_store_probe2 set epoch = epoch + 1 where id = 1 and epoch = $1 returning epoch',
      [999],
    );
    assert.equal(miss.rowCount, 0);
    const hit = await pool.query(
      'update ai_store_probe2 set epoch = epoch + 1 where id = 1 and epoch = $1 returning epoch',
      [1],
    );
    assert.equal(hit.rowCount, 1);
    assert.equal(hit.rows[0].epoch, 2);
  } finally {
    await pool.query('drop table if exists ai_store_probe2');
    await pool.end();
  }
});

test('a caller-supplied connection option is kept, not overwritten by ours', async () => {
  const pool = createAiPool({
    connectionString: URL,
    options: '-c statement_timeout=7000',
  });
  try {
    const c = await pool.connect();
    try {
      assert.equal((await c.query('show statement_timeout')).rows[0].statement_timeout, '7s');
      assert.equal(
        (await c.query('show transaction_isolation')).rows[0].transaction_isolation,
        'read committed',
      );
    } finally {
      c.release();
    }
  } finally {
    await pool.end();
  }
});
