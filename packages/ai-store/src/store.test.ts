import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { migrateUp } from './migrations.ts';
import { AiStore } from './store.ts';

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is required for PostgreSQL contract tests';
const store = databaseUrl ? new AiStore(databaseUrl, 20) : null;

before(async () => {
  if (!store) return;
  await migrateUp(store.pool);
});

beforeEach(async () => {
  if (!store) return;
  await store.pool.query(
    'TRUNCATE audit_events, outbox, leads, conversation_events, conversation_messages, engine_run_handles, conversation_credentials, conversations, ai_runs RESTART IDENTITY CASCADE',
  );
});

after(async () => {
  if (!store) return;
  await store.pool.query(
    'TRUNCATE ai_rate_limit_buckets, audit_events, outbox, leads, conversation_events, conversation_messages, engine_run_handles, conversation_credentials, conversations, ai_runs RESTART IDENTITY CASCADE',
  );
  await store.close();
});

test('migration is idempotent and leaves the runtime schema available', { skip }, async () => {
  assert.ok(store);
  await migrateUp(store.pool);
  const applied = await store.pool.query(
    "SELECT to_regclass('public.conversations') AS table_name",
  );
  assert.equal(applied.rows[0]?.table_name, 'conversations');
});

test(
  'visitor message replay is idempotent and creates one live run/outbox item',
  { skip },
  async () => {
    assert.ok(store);
    const conversation = await store.createConversation();
    const input = {
      conversationId: conversation.id,
      idempotencyKey: 'msg-1',
      content: 'What is your MOQ?',
      engineId: 'fake',
      engineVersion: '0.1.0',
    };
    const first = await store.appendVisitorMessage(input);
    const replay = await store.appendVisitorMessage(input);
    assert.equal(first.replayed, false);
    assert.ok(first.run);
    assert.deepEqual(replay, { messageId: first.messageId, run: null, replayed: true });
    const counts = await store.pool.query(
      'SELECT (SELECT count(*) FROM conversation_messages)::int AS messages, (SELECT count(*) FROM ai_runs)::int AS runs, (SELECT count(*) FROM outbox)::int AS outbox',
    );
    assert.deepEqual(counts.rows[0], { messages: 1, runs: 1, outbox: 1 });
  },
);

test(
  'run context excludes queued messages and a fenced final stores the assistant turn',
  { skip },
  async () => {
    assert.ok(store);
    const conversation = await store.createConversation();
    const first = await store.appendVisitorMessage({
      conversationId: conversation.id,
      idempotencyKey: 'context-1',
      content: 'first question',
      engineId: 'fake',
      engineVersion: '0.1.0',
    });
    await store.appendVisitorMessage({
      conversationId: conversation.id,
      idempotencyKey: 'context-2',
      content: 'queued question',
      engineId: 'fake',
      engineVersion: '0.1.0',
    });
    assert.ok(first.run);
    const claim = await store.claimRun(first.run.id);
    assert.ok(claim);
    const context = await store.getRunExecutionContext(first.run.id);
    assert.deepEqual(context?.turns, [{ role: 'visitor', text: 'first question' }]);

    const final = await store.appendEventFenced({
      conversationId: conversation.id,
      runId: first.run.id,
      expectedControlVersion: claim.controlVersion,
      claimEpoch: claim.claimEpoch,
      type: 'final',
      payload: { text: 'grounded answer' },
    });
    assert.ok(final);
    const messages = await store.pool.query<{
      role: string;
      content: string;
      event_sequence: string | null;
    }>(
      `SELECT role, content, event_sequence FROM conversation_messages
     WHERE conversation_id = $1 ORDER BY created_at, id`,
      [conversation.id],
    );
    assert.deepEqual(messages.rows, [
      { role: 'visitor', content: 'first question', event_sequence: null },
      { role: 'visitor', content: 'queued question', event_sequence: null },
      { role: 'assistant', content: 'grounded answer', event_sequence: String(final.sequence) },
    ]);
  },
);

test('database rejects an event whose run belongs to another conversation', { skip }, async () => {
  assert.ok(store);
  const a = await store.createConversation();
  const b = await store.createConversation();
  const accepted = await store.appendVisitorMessage({
    conversationId: a.id,
    idempotencyKey: 'a-1',
    content: 'hello',
    engineId: 'fake',
    engineVersion: '0.1.0',
  });
  assert.ok(accepted.run);
  await assert.rejects(
    store.pool.query(
      `INSERT INTO conversation_events(conversation_id, run_id, sequence, type, payload)
       VALUES ($1, $2, 1, 'token', '{"text":"leak"}')`,
      [b.id, accepted.run.id],
    ),
    /foreign key constraint/,
  );
});

test('database rejects an engine handle attached to the wrong operation', { skip }, async () => {
  assert.ok(store);
  const conversation = await store.createConversation();
  const accepted = await store.appendVisitorMessage({
    conversationId: conversation.id,
    idempotencyKey: 'handle-1',
    content: 'hello',
    engineId: 'fake',
    engineVersion: '0.1.0',
  });
  assert.ok(accepted.run);
  await assert.rejects(
    store.pool.query(
      `INSERT INTO engine_run_handles(conversation_id, run_id, operation_id, engine_run_id)
       VALUES ($1, $2, 'run:wrong-operation', 'vendor-run-1')`,
      [conversation.id, accepted.run.id],
    ),
    /foreign key constraint/,
  );
});

test('database rejects model text smuggled inside a system event', { skip }, async () => {
  assert.ok(store);
  const conversation = await store.createConversation();
  await assert.rejects(
    store.pool.query(
      `INSERT INTO conversation_events(conversation_id, sequence, type, payload)
       VALUES ($1, 1, 'handoff.started', '{"text":"vendor output"}')`,
      [conversation.id],
    ),
    /check constraint/,
  );
});

test(
  'concurrent fenced appends are gapless and a stale fence writes nothing',
  { skip },
  async () => {
    assert.ok(store);
    const conversation = await store.createConversation();
    const accepted = await store.appendVisitorMessage({
      conversationId: conversation.id,
      idempotencyKey: 'm-1',
      content: 'hello',
      engineId: 'fake',
      engineVersion: '0.1.0',
    });
    assert.ok(accepted.run);
    const claim = await store.claimRun(accepted.run.id);
    assert.ok(claim);
    const appended = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.appendEventFenced({
          conversationId: conversation.id,
          runId: accepted.run?.id ?? '',
          expectedControlVersion: claim.controlVersion,
          claimEpoch: claim.claimEpoch,
          type: 'token',
          payload: { text: `t${index}` },
        }),
      ),
    );
    assert.deepEqual(
      appended.map((event) => event?.sequence).sort((a, b) => (a ?? 0) - (b ?? 0)),
      Array.from({ length: 12 }, (_, index) => index + 1),
    );

    const takeover = await store.transitionControl({
      conversationId: conversation.id,
      expectedVersion: claim.controlVersion,
      from: 'ai',
      to: 'human',
      assignedUserId: 'sales-1',
    });
    assert.ok(takeover);
    const stale = await store.appendEventFenced({
      conversationId: conversation.id,
      runId: accepted.run.id,
      expectedControlVersion: claim.controlVersion,
      claimEpoch: claim.claimEpoch,
      type: 'token',
      payload: { text: 'must-not-commit' },
    });
    assert.equal(stale, null);
    assert.equal((await store.listEvents(conversation.id)).length, 12);
  },
);

test(
  'approved events, assistant turn, and completed status commit as one fenced transaction',
  { skip },
  async () => {
    assert.ok(store);
    const conversation = await store.createConversation();
    const accepted = await store.appendVisitorMessage({
      conversationId: conversation.id,
      idempotencyKey: 'atomic-final-1',
      content: 'hello',
      engineId: 'fake',
      engineVersion: '0.1.0',
    });
    assert.ok(accepted.run);
    const claim = await store.claimRun(accepted.run.id);
    assert.ok(claim);

    assert.equal(
      await store.finishRunFenced({
        conversationId: conversation.id,
        runId: accepted.run.id,
        expectedControlVersion: claim.controlVersion,
        claimEpoch: claim.claimEpoch,
        status: 'completed',
        events: [
          { type: 'token', payload: { text: 'approved answer' } },
          {
            type: 'citation',
            payload: { sourceId: 'channelkb-g1-faq', title: 'Public FAQ' },
          },
          { type: 'final', payload: { text: 'approved answer' } },
        ],
      }),
      true,
    );

    assert.deepEqual(
      (await store.listEvents(conversation.id)).map((event) => event.type),
      ['token', 'citation', 'final'],
    );
    const run = await store.pool.query<{ status: string }>(
      'SELECT status FROM ai_runs WHERE id=$1',
      [accepted.run.id],
    );
    assert.equal(run.rows[0]?.status, 'completed');
    assert.equal((await store.getConversation(conversation.id))?.activeRunId, null);
    const assistant = await store.pool.query<{ content: string }>(
      `SELECT content FROM conversation_messages
       WHERE conversation_id=$1 AND role='assistant'`,
      [conversation.id],
    );
    assert.deepEqual(assistant.rows, [{ content: 'approved answer' }]);
  },
);

test('a mid-batch database rejection rolls back events and run completion', { skip }, async () => {
  assert.ok(store);
  const conversation = await store.createConversation();
  const accepted = await store.appendVisitorMessage({
    conversationId: conversation.id,
    idempotencyKey: 'atomic-final-rollback',
    content: 'hello',
    engineId: 'fake',
    engineVersion: '0.1.0',
  });
  assert.ok(accepted.run);
  const claim = await store.claimRun(accepted.run.id);
  assert.ok(claim);

  await assert.rejects(
    store.finishRunFenced({
      conversationId: conversation.id,
      runId: accepted.run.id,
      expectedControlVersion: claim.controlVersion,
      claimEpoch: claim.claimEpoch,
      status: 'completed',
      events: [
        { type: 'token', payload: { text: 'must roll back' } },
        { type: 'final', payload: {} },
      ],
    }),
    /constraint|null value|violates/i,
  );
  assert.deepEqual(await store.listEvents(conversation.id), []);
  const run = await store.pool.query<{ status: string }>('SELECT status FROM ai_runs WHERE id=$1', [
    accepted.run.id,
  ]);
  assert.equal(run.rows[0]?.status, 'running');
});

test('terminalization requires its durable authority and cancellation wins', { skip }, async () => {
  assert.ok(store);
  const conversation = await store.createConversation();
  const accepted = await store.appendVisitorMessage({
    conversationId: conversation.id,
    idempotencyKey: 'terminal-authority',
    content: 'stop this answer',
    engineId: 'fake',
    engineVersion: '0.1.0',
  });
  assert.ok(accepted.run);

  assert.equal(
    await store.terminalizeRun({
      runId: accepted.run.id,
      reason: 'cancel_requested',
    }),
    false,
  );
  assert.equal(await store.requestCancellation(conversation.id, conversation.controlVersion), true);
  assert.equal(
    await store.terminalizeRun({
      runId: accepted.run.id,
      reason: 'cancel_requested',
    }),
    true,
  );

  const run = await store.pool.query<{ status: string }>('SELECT status FROM ai_runs WHERE id=$1', [
    accepted.run.id,
  ]);
  assert.equal(run.rows[0]?.status, 'cancelled');
  assert.deepEqual(
    (await store.listEvents(conversation.id)).map((event) => event.type),
    ['assistant.cancelled'],
  );
});

test(
  'reclaim terminalization is claim-fenced and preserves cancellation precedence',
  { skip },
  async () => {
    assert.ok(store);
    const conversation = await store.createConversation();
    const accepted = await store.appendVisitorMessage({
      conversationId: conversation.id,
      idempotencyKey: 'terminal-reclaim',
      content: 'question',
      engineId: 'fake',
      engineVersion: '0.1.0',
    });
    assert.ok(accepted.run);
    const first = await store.claimRun(accepted.run.id);
    const reclaimed = await store.claimRun(accepted.run.id);
    assert.ok(first);
    assert.ok(reclaimed?.reclaimed);

    assert.equal(
      await store.terminalizeRun({
        runId: accepted.run.id,
        reason: 'reclaimed',
        claimEpoch: first.claimEpoch,
      }),
      false,
    );
    assert.equal(
      await store.requestCancellation(conversation.id, conversation.controlVersion),
      true,
    );
    assert.equal(
      await store.terminalizeRun({
        runId: accepted.run.id,
        reason: 'reclaimed',
        claimEpoch: reclaimed.claimEpoch,
        failurePayload: { category: 'transient' },
      }),
      true,
    );
    const run = await store.pool.query<{ status: string }>(
      'SELECT status FROM ai_runs WHERE id=$1',
      [accepted.run.id],
    );
    assert.equal(run.rows[0]?.status, 'cancelled');
  },
);

test('dead-letter terminalization proves the matching start-run record', { skip }, async () => {
  assert.ok(store);
  const conversation = await store.createConversation();
  const accepted = await store.appendVisitorMessage({
    conversationId: conversation.id,
    idempotencyKey: 'terminal-dead-letter',
    content: 'question',
    engineId: 'fake',
    engineVersion: '0.1.0',
  });
  assert.ok(accepted.run);
  const outbox = await store.pool.query<{ id: string }>(
    "SELECT id FROM outbox WHERE run_id=$1 AND type='start_run'",
    [accepted.run.id],
  );
  const outboxId = outbox.rows[0]?.id;
  assert.ok(outboxId);

  assert.equal(
    await store.terminalizeRun({
      runId: accepted.run.id,
      reason: 'start_run_dead_letter',
      outboxId,
    }),
    false,
  );
  await store.pool.query("UPDATE outbox SET status='dead_letter' WHERE id=$1", [outboxId]);
  assert.equal(
    await store.terminalizeRun({
      runId: accepted.run.id,
      reason: 'start_run_dead_letter',
      outboxId,
      failurePayload: { category: 'unavailable' },
    }),
    true,
  );
  const run = await store.pool.query<{ status: string }>('SELECT status FROM ai_runs WHERE id=$1', [
    accepted.run.id,
  ]);
  assert.equal(run.rows[0]?.status, 'failed');
});

/**
 * The dead-letter transition and the run's terminalization are ONE fact.
 *
 * They used to be two statements in two transactions. Anything that stopped the
 * process between them — a crash, a lost connection, a container restart —
 * committed the outbox row as permanently dead-lettered while the run stayed
 * `creating` and the conversation kept pointing at it. Nothing would ever claim
 * that item again and nothing would ever finish that run, so the visitor
 * watched a spinner forever and no operator signal fired.
 */
async function deadLetterFixture(key: string) {
  assert.ok(store);
  const conversation = await store.createConversation();
  const accepted = await store.appendVisitorMessage({
    conversationId: conversation.id,
    idempotencyKey: key,
    content: 'question',
    engineId: 'fake',
    engineVersion: '0.1.0',
  });
  assert.ok(accepted.run);
  const claimed = await store.claimNextOutbox(60);
  assert.ok(claimed);
  const runClaim = await store.claimRun(accepted.run.id);
  assert.ok(runClaim, 'the real worker claims the run before engine work can fail');
  return { conversation, run: accepted.run, item: claimed };
}

test(
  'the last failed attempt dead-letters the item and fails the run together',
  { skip },
  async () => {
    assert.ok(store);
    const { conversation, run, item } = await deadLetterFixture('atomic-dead-letter');

    const disposition = await store.failOutboxAttempt({
      id: item.id,
      claimEpoch: item.claimEpoch,
      category: 'unavailable',
      delaySeconds: 1,
      maxAttempts: 0, // this attempt is the last one
      runId: item.runId,
      type: item.type,
    });
    assert.equal(disposition, 'dead_letter');

    const outbox = await store.pool.query<{ status: string }>(
      'SELECT status FROM outbox WHERE id=$1',
      [item.id],
    );
    const runRow = await store.pool.query<{ status: string }>(
      'SELECT status FROM ai_runs WHERE id=$1',
      [run.id],
    );
    const convo = await store.pool.query<{ active_run_id: string | null }>(
      'SELECT active_run_id FROM conversations WHERE id=$1',
      [conversation.id],
    );
    assert.equal(outbox.rows[0]?.status, 'dead_letter');
    assert.equal(runRow.rows[0]?.status, 'failed');
    assert.equal(convo.rows[0]?.active_run_id, null, 'conversation still points at a dead run');
  },
);

test(
  'CRASH BOUNDARY: no durable state has a dead-letter item beside a live run',
  { skip },
  async () => {
    assert.ok(store);
    const { conversation, run, item } = await deadLetterFixture('crash-boundary');

    // Reproduce the crash precisely: run the same transaction the worker runs,
    // then abort it at the exact point the old code committed. If the two facts
    // are one transaction, the rollback must take BOTH — leaving the item
    // reclaimable and the run still alive, which is a recoverable state.
    const client = await store.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query(
        `UPDATE outbox SET status='dead_letter', claimed_until=NULL, updated_at=clock_timestamp()
         WHERE id=$1 AND claim_epoch=$2 AND status='processing'`,
        [item.id, item.claimEpoch],
      );
      await client.query('ROLLBACK'); // the crash
    } finally {
      client.release();
    }

    const outbox = await store.pool.query<{ status: string }>(
      'SELECT status FROM outbox WHERE id=$1',
      [item.id],
    );
    const runRow = await store.pool.query<{ status: string }>(
      'SELECT status FROM ai_runs WHERE id=$1',
      [run.id],
    );
    assert.notEqual(
      outbox.rows[0]?.status,
      'dead_letter',
      'the item was dead-lettered by a transaction that did not also finish the run',
    );
    assert.ok(['creating', 'running'].includes(runRow.rows[0]?.status ?? ''));

    // And the recovery path still works afterwards: the same worker call now
    // commits both facts, so the pair can never be observed half-applied.
    const disposition = await store.failOutboxAttempt({
      id: item.id,
      claimEpoch: item.claimEpoch,
      category: 'unavailable',
      delaySeconds: 1,
      maxAttempts: 0,
      runId: item.runId,
      type: item.type,
    });
    assert.equal(disposition, 'dead_letter');

    const after = await store.pool.query<{ o: string; r: string; a: string | null }>(
      `SELECT o.status AS o, r.status AS r, c.active_run_id AS a
       FROM outbox o JOIN ai_runs r ON r.id = o.run_id
       JOIN conversations c ON c.id = r.conversation_id
       WHERE o.id = $1`,
      [item.id],
    );
    const row = after.rows[0];
    assert.equal(row?.o, 'dead_letter');
    assert.equal(row?.r, 'failed');
    assert.equal(row?.a, null);
    assert.ok(conversation.id);

    // The invariant itself, asked of the whole database rather than of the row
    // this test happens to know about. This is the state the old two-statement
    // path could leave behind, and it must be unreachable by construction.
    const orphans = await store.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM outbox o JOIN ai_runs r ON r.id = o.run_id
       WHERE o.type = 'start_run' AND o.status = 'dead_letter'
         AND r.status IN ('creating', 'running')`,
    );
    assert.equal(
      Number(orphans.rows[0]?.n),
      0,
      'a dead-letter start_run exists whose run is still live: nothing will claim it, nothing will finish it',
    );
  },
);

test('a non-final failed attempt neither dead-letters nor touches the run', { skip }, async () => {
  assert.ok(store);
  const { run, item } = await deadLetterFixture('retry-not-terminal');
  const disposition = await store.failOutboxAttempt({
    id: item.id,
    claimEpoch: item.claimEpoch,
    category: 'transient',
    delaySeconds: 1,
    maxAttempts: 5,
    runId: item.runId,
    type: item.type,
  });
  assert.equal(disposition, 'retry');
  const runRow = await store.pool.query<{ status: string }>(
    'SELECT status FROM ai_runs WHERE id=$1',
    [run.id],
  );
  assert.ok(['creating', 'running'].includes(runRow.rows[0]?.status ?? ''));
});
