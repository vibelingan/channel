import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

export type EventType =
  | 'token'
  | 'citation'
  | 'final'
  | 'error'
  | 'handoff.started'
  | 'assistant.cancelled'
  | 'run.failed'
  | 'conversation.closed';

export interface ConversationRow {
  id: string;
  status: 'ai' | 'handoff_requested' | 'human' | 'closed';
  controlVersion: number;
  takeoverEpoch: number;
  activeRunId: string | null;
}

export interface EventRow {
  id: string;
  conversationId: string;
  runId: string | null;
  sequence: number;
  type: EventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface NewRun {
  id: string;
  operationId: string;
}

export interface OutboxItem {
  id: string;
  conversationId: string;
  runId: string | null;
  type: 'start_run' | 'cancel_run' | 'sales_notification' | 'email' | 'crm';
  payload: Record<string, unknown>;
  attempts: number;
  claimEpoch: number;
}

export interface RunExecutionContext {
  conversationId: string;
  runId: string;
  operationId: string;
  controlVersion: number;
  claimEpoch: number;
  locale: string;
  turns: Array<{ role: 'visitor' | 'assistant'; text: string }>;
}

export class AiStore {
  readonly pool: Pool;

  constructor(databaseUrl: string, max = 10) {
    this.pool = new Pool({ connectionString: databaseUrl, max });
  }

  close(): Promise<void> {
    return this.pool.end();
  }

  async health(): Promise<{ database: 'live'; isolation: string }> {
    const result = await this.pool.query<{ isolation: string }>(
      "SELECT current_setting('transaction_isolation') AS isolation",
    );
    const isolation = result.rows[0]?.isolation ?? 'unknown';
    if (isolation !== 'read committed') {
      throw new Error(`unsupported_transaction_isolation:${isolation}`);
    }
    return { database: 'live', isolation };
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createConversation(locale = 'en'): Promise<ConversationRow> {
    const result = await this.pool.query<{
      id: string;
      status: ConversationRow['status'];
      control_version: string;
      takeover_epoch: string;
      active_run_id: string | null;
    }>(
      `INSERT INTO conversations(locale)
       VALUES ($1)
       RETURNING id, status, control_version, takeover_epoch, active_run_id`,
      [locale],
    );
    const row = result.rows[0];
    if (!row) throw new Error('conversation_insert_failed');
    return mapConversation(row);
  }

  async createConversationWithCredential(
    locale: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<ConversationRow> {
    return this.transaction(async (client) => {
      const result = await client.query<{
        id: string;
        status: ConversationRow['status'];
        control_version: string;
        takeover_epoch: string;
        active_run_id: string | null;
      }>(
        `INSERT INTO conversations(locale)
         VALUES ($1)
         RETURNING id, status, control_version, takeover_epoch, active_run_id`,
        [locale],
      );
      const row = result.rows[0];
      if (!row) throw new Error('conversation_insert_failed');
      await client.query(
        `INSERT INTO conversation_credentials(conversation_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [row.id, tokenHash, expiresAt],
      );
      await client.query(
        `INSERT INTO audit_events(conversation_id, actor_type, action)
         VALUES ($1, 'visitor', 'conversation.created')`,
        [row.id],
      );
      return mapConversation(row);
    });
  }

  async getConversation(id: string): Promise<ConversationRow | null> {
    const result = await this.pool.query<{
      id: string;
      status: ConversationRow['status'];
      control_version: string;
      takeover_epoch: string;
      active_run_id: string | null;
    }>(
      `SELECT id, status, control_version, takeover_epoch, active_run_id
       FROM conversations WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapConversation(result.rows[0]) : null;
  }

  async storeCredential(conversationId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO conversation_credentials(conversation_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [conversationId, tokenHash, expiresAt],
    );
  }

  async verifyCredential(conversationId: string, tokenHash: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM conversation_credentials
       WHERE conversation_id = $1 AND token_hash = $2
         AND revoked_at IS NULL AND expires_at > clock_timestamp()`,
      [conversationId, tokenHash],
    );
    return result.rowCount === 1;
  }

  async reserveRateLimit(input: {
    bucketKey: string;
    windowSeconds: number;
    limit: number;
  }): Promise<{ allowed: boolean; remaining: number }> {
    const result = await this.pool.query<{ hits: number }>(
      `INSERT INTO ai_rate_limit_buckets(bucket_key, window_started_at, hits)
       VALUES (
         $1,
         to_timestamp(floor(extract(epoch FROM clock_timestamp()) / $2) * $2),
         1
       )
       ON CONFLICT (bucket_key, window_started_at)
       DO UPDATE SET hits = ai_rate_limit_buckets.hits + 1
         WHERE ai_rate_limit_buckets.hits < $3
       RETURNING hits`,
      [input.bucketKey, input.windowSeconds, input.limit],
    );
    const hits = result.rows[0]?.hits;
    return hits === undefined
      ? { allowed: false, remaining: 0 }
      : { allowed: true, remaining: Math.max(0, input.limit - hits) };
  }

  async appendVisitorMessage(input: {
    conversationId: string;
    idempotencyKey: string;
    content: string;
    engineId: string;
    engineVersion: string;
    imageDigest?: string;
  }): Promise<{ messageId: string; run: NewRun | null; replayed: boolean }> {
    return this.transaction(async (client) => {
      const conversation = await client.query<{
        status: ConversationRow['status'];
        control_version: string;
        takeover_epoch: string;
        active_run_id: string | null;
      }>(
        `SELECT status, control_version, takeover_epoch, active_run_id
         FROM conversations WHERE id = $1 FOR UPDATE`,
        [input.conversationId],
      );
      const row = conversation.rows[0];
      if (!row) throw new Error('conversation_not_found');
      if (row.status === 'closed') throw new Error('conversation_closed');

      const existing = await client.query<{ id: string }>(
        `SELECT id FROM conversation_messages
         WHERE conversation_id = $1 AND idempotency_key = $2`,
        [input.conversationId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        return { messageId: existing.rows[0].id, run: null, replayed: true };
      }

      const messageId = randomUUID();
      await client.query(
        `INSERT INTO conversation_messages(
           id, conversation_id, role, content, idempotency_key, accepted_in_epoch
         ) VALUES ($1, $2, 'visitor', $3, $4, $5)`,
        [messageId, input.conversationId, input.content, input.idempotencyKey, row.takeover_epoch],
      );
      await client.query(
        `INSERT INTO audit_events(conversation_id, actor_type, action, metadata)
         VALUES ($1, 'visitor', 'message.accepted', jsonb_build_object('messageId', $2::text))`,
        [input.conversationId, messageId],
      );

      if (row.status !== 'ai' || row.active_run_id) {
        return { messageId, run: null, replayed: false };
      }

      const runId = randomUUID();
      const operationId = `run:${runId}`;
      await client.query(
        `INSERT INTO ai_runs(
           id, conversation_id, operation_id, control_version,
           engine_id, engine_version, image_digest
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          runId,
          input.conversationId,
          operationId,
          row.control_version,
          input.engineId,
          input.engineVersion,
          input.imageDigest ?? null,
        ],
      );
      await client.query(
        `UPDATE conversation_messages SET answered_by_run = $2
         WHERE id = $1`,
        [messageId, runId],
      );
      await client.query(
        `UPDATE conversations SET active_run_id = $2, updated_at = clock_timestamp()
         WHERE id = $1`,
        [input.conversationId, runId],
      );
      await client.query(
        `INSERT INTO outbox(conversation_id, run_id, type, payload)
         VALUES ($1, $2, 'start_run', jsonb_build_object('messageId', $3::text))`,
        [input.conversationId, runId, messageId],
      );
      return { messageId, run: { id: runId, operationId }, replayed: false };
    });
  }

  async claimNextOutbox(leaseSeconds = 30): Promise<OutboxItem | null> {
    const result = await this.pool.query<{
      id: string;
      conversation_id: string;
      run_id: string | null;
      type: OutboxItem['type'];
      payload: Record<string, unknown>;
      attempts: number;
      claim_epoch: string;
    }>(
      `WITH candidate AS (
         SELECT id FROM outbox
         WHERE available_at <= clock_timestamp()
           AND (
             status = 'pending' OR
             (status = 'processing' AND claimed_until < clock_timestamp())
           )
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE outbox AS o
       SET status = 'processing',
           attempts = o.attempts + 1,
           claim_epoch = o.claim_epoch + 1,
           claimed_until = clock_timestamp() + make_interval(secs => $1),
           updated_at = clock_timestamp()
       FROM candidate
       WHERE o.id = candidate.id
       RETURNING o.id, o.conversation_id, o.run_id, o.type, o.payload,
                 o.attempts, o.claim_epoch`,
      [leaseSeconds],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          conversationId: row.conversation_id,
          runId: row.run_id,
          type: row.type,
          payload: row.payload,
          attempts: row.attempts,
          claimEpoch: Number(row.claim_epoch),
        }
      : null;
  }

  async completeOutbox(id: string, claimEpoch: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE outbox SET status = 'completed', claimed_until = NULL,
         updated_at = clock_timestamp()
       WHERE id = $1 AND status = 'processing' AND claim_epoch = $2`,
      [id, claimEpoch],
    );
    return result.rowCount === 1;
  }

  async retryOutbox(input: {
    id: string;
    claimEpoch: number;
    category: string;
    delaySeconds: number;
    maxAttempts: number;
  }): Promise<'retry' | 'dead_letter' | 'stale'> {
    const result = await this.pool.query<{ status: 'pending' | 'dead_letter' }>(
      `UPDATE outbox
       SET status = CASE WHEN attempts >= $5 THEN 'dead_letter' ELSE 'pending' END,
           available_at = CASE WHEN attempts >= $5 THEN available_at
             ELSE clock_timestamp() + make_interval(secs => $4) END,
           claimed_until = NULL,
           last_error_category = $3,
           updated_at = clock_timestamp()
       WHERE id = $1 AND claim_epoch = $2 AND status = 'processing'
       RETURNING status`,
      [input.id, input.claimEpoch, input.category, input.delaySeconds, input.maxAttempts],
    );
    const status = result.rows[0]?.status;
    return status === 'pending' ? 'retry' : status === 'dead_letter' ? 'dead_letter' : 'stale';
  }

  async getRunExecutionContext(runId: string): Promise<RunExecutionContext | null> {
    const run = await this.pool.query<{
      conversation_id: string;
      id: string;
      operation_id: string;
      control_version: string;
      claim_epoch: string;
      locale: string;
    }>(
      `SELECT r.conversation_id, r.id, r.operation_id, r.control_version,
              r.claim_epoch, c.locale
       FROM ai_runs r JOIN conversations c ON c.id = r.conversation_id
       WHERE r.id = $1 AND r.status = 'running'`,
      [runId],
    );
    const row = run.rows[0];
    if (!row) return null;
    const turns = await this.pool.query<{ role: 'visitor' | 'assistant'; content: string }>(
      `SELECT role, content FROM conversation_messages
       WHERE conversation_id = $1 AND role IN ('visitor', 'assistant')
         AND (role = 'assistant' OR answered_by_run IS NOT NULL)
       ORDER BY created_at ASC, id ASC LIMIT 30`,
      [row.conversation_id],
    );
    return {
      conversationId: row.conversation_id,
      runId: row.id,
      operationId: row.operation_id,
      controlVersion: Number(row.control_version),
      claimEpoch: Number(row.claim_epoch),
      locale: row.locale,
      turns: turns.rows.map((turn) => ({ role: turn.role, text: turn.content })),
    };
  }

  async getEngineHandle(runId: string): Promise<{
    operationId: string;
    engineRunId: string;
  } | null> {
    const result = await this.pool.query<{ operation_id: string; engine_run_id: string }>(
      `SELECT operation_id, engine_run_id FROM ai_runs
       WHERE id = $1 AND engine_run_id IS NOT NULL`,
      [runId],
    );
    const row = result.rows[0];
    return row ? { operationId: row.operation_id, engineRunId: row.engine_run_id } : null;
  }

  async terminalizeRun(input: {
    runId: string;
    status: 'completed' | 'failed' | 'cancelled';
    eventType?: 'assistant.cancelled' | 'run.failed';
    eventPayload?: Record<string, unknown>;
  }): Promise<boolean> {
    return this.transaction(async (client) => {
      const run = await client.query<{
        conversation_id: string;
        engine_id: string;
        engine_version: string;
        image_digest: string | null;
      }>(
        `UPDATE ai_runs SET status = $2, updated_at = clock_timestamp()
         WHERE id = $1 AND status IN ('creating', 'running')
         RETURNING conversation_id, engine_id, engine_version, image_digest`,
        [input.runId, input.status],
      );
      const row = run.rows[0];
      if (!row) return false;

      const conversation = await client.query<{
        status: ConversationRow['status'];
        takeover_epoch: string;
        next_event_sequence: string;
      }>(
        `UPDATE conversations
         SET active_run_id = NULL, updated_at = clock_timestamp()
         WHERE id = $1 AND active_run_id = $2
         RETURNING status, takeover_epoch, next_event_sequence`,
        [row.conversation_id, input.runId],
      );
      const control = conversation.rows[0];
      if (!control) return true;

      if (input.eventType) {
        const sequence = Number(control.next_event_sequence);
        await client.query(
          `INSERT INTO conversation_events(conversation_id, run_id, sequence, type, payload)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            row.conversation_id,
            input.runId,
            sequence,
            input.eventType,
            JSON.stringify(input.eventPayload ?? {}),
          ],
        );
        await client.query(
          `UPDATE conversations SET next_event_sequence = next_event_sequence + 1
           WHERE id = $1`,
          [row.conversation_id],
        );
      }

      if (control.status !== 'ai') return true;
      const queued = await client.query<{ id: string }>(
        `SELECT id FROM conversation_messages
         WHERE conversation_id = $1 AND role = 'visitor'
           AND answered_by_run IS NULL AND accepted_in_epoch = $2
         ORDER BY created_at ASC, id ASC FOR UPDATE SKIP LOCKED LIMIT 1`,
        [row.conversation_id, control.takeover_epoch],
      );
      const message = queued.rows[0];
      if (!message) return true;

      const nextRunId = randomUUID();
      await client.query(
        `INSERT INTO ai_runs(
           id, conversation_id, operation_id, control_version,
           engine_id, engine_version, image_digest
         ) SELECT $2, id, $3, control_version, $4, $5, $6
           FROM conversations WHERE id = $1`,
        [
          row.conversation_id,
          nextRunId,
          `run:${nextRunId}`,
          row.engine_id,
          row.engine_version,
          row.image_digest,
        ],
      );
      await client.query('UPDATE conversation_messages SET answered_by_run = $2 WHERE id = $1', [
        message.id,
        nextRunId,
      ]);
      await client.query('UPDATE conversations SET active_run_id = $2 WHERE id = $1', [
        row.conversation_id,
        nextRunId,
      ]);
      await client.query(
        `INSERT INTO outbox(conversation_id, run_id, type, payload)
         VALUES ($1, $2, 'start_run', jsonb_build_object('messageId', $3::text))`,
        [row.conversation_id, nextRunId, message.id],
      );
      return true;
    });
  }

  async claimRun(runId: string): Promise<{
    claimEpoch: number;
    controlVersion: number;
    reclaimed: boolean;
  } | null> {
    const result = await this.pool.query<{
      claim_epoch: string;
      control_version: string;
      prior_status: 'creating' | 'running';
    }>(
      `WITH candidate AS (
         SELECT id, status AS prior_status FROM ai_runs
         WHERE id = $1 AND status IN ('creating', 'running')
         FOR UPDATE
       )
       UPDATE ai_runs AS r
       SET status = 'running', claim_epoch = r.claim_epoch + 1,
           updated_at = clock_timestamp()
       FROM candidate
       WHERE r.id = candidate.id
       RETURNING r.claim_epoch, r.control_version, candidate.prior_status`,
      [runId],
    );
    const row = result.rows[0];
    return row
      ? {
          claimEpoch: Number(row.claim_epoch),
          controlVersion: Number(row.control_version),
          reclaimed: row.prior_status === 'running',
        }
      : null;
  }

  async recordEngineHandle(input: {
    conversationId: string;
    runId: string;
    operationId: string;
    engineRunId: string;
  }): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO engine_run_handles(conversation_id, run_id, operation_id, engine_run_id)
         VALUES ($1, $2, $3, $4)`,
        [input.conversationId, input.runId, input.operationId, input.engineRunId],
      );
      await client.query(
        `UPDATE ai_runs SET engine_run_id = $2, updated_at = clock_timestamp()
         WHERE id = $1`,
        [input.runId, input.engineRunId],
      );
    });
  }

  async appendEventFenced(input: {
    conversationId: string;
    runId: string;
    expectedControlVersion: number;
    claimEpoch: number;
    type: EventType;
    payload: Record<string, unknown>;
  }): Promise<EventRow | null> {
    const result = await this.pool.query<{
      id: string;
      conversation_id: string;
      run_id: string;
      sequence: string;
      type: EventType;
      payload: Record<string, unknown>;
      created_at: Date;
    }>(
      `WITH fenced_sequence AS (
         UPDATE conversations AS c
         SET next_event_sequence = c.next_event_sequence + 1,
             updated_at = clock_timestamp()
         FROM ai_runs AS r
         WHERE c.id = $1
           AND r.id = $2
           AND r.conversation_id = c.id
           AND c.status = 'ai'
           AND c.control_version = $3
           AND c.active_run_id = r.id
           AND r.status = 'running'
           AND r.claim_epoch = $4
           AND r.cancel_requested_at IS NULL
         RETURNING c.next_event_sequence - 1 AS sequence
       ), inserted_event AS (
         INSERT INTO conversation_events(conversation_id, run_id, sequence, type, payload)
         SELECT $1, $2, sequence, $5, $6::jsonb FROM fenced_sequence
         RETURNING id, conversation_id, run_id, sequence, type, payload, created_at
       ), inserted_message AS (
         INSERT INTO conversation_messages(
           conversation_id, role, content, idempotency_key, accepted_in_epoch,
           answered_by_run, event_sequence
         )
         SELECT e.conversation_id, 'assistant', e.payload ->> 'text',
                'assistant:' || e.run_id::text, c.takeover_epoch, e.run_id, e.sequence
         FROM inserted_event e
         JOIN conversations c ON c.id = e.conversation_id
         WHERE e.type = 'final'
         ON CONFLICT (conversation_id, idempotency_key) DO NOTHING
         RETURNING id
       )
       SELECT id, conversation_id, run_id, sequence, type, payload, created_at
       FROM inserted_event`,
      [
        input.conversationId,
        input.runId,
        input.expectedControlVersion,
        input.claimEpoch,
        input.type,
        JSON.stringify(input.payload),
      ],
    );
    return result.rows[0] ? mapEvent(result.rows[0]) : null;
  }

  async transitionControl(input: {
    conversationId: string;
    expectedVersion: number;
    from: ConversationRow['status'];
    to: ConversationRow['status'];
    assignedUserId?: string;
  }): Promise<ConversationRow | null> {
    const result = await this.pool.query<{
      id: string;
      status: ConversationRow['status'];
      control_version: string;
      takeover_epoch: string;
      active_run_id: string | null;
    }>(
      `UPDATE conversations
       SET status = $4,
           control_version = control_version + 1,
           takeover_epoch = takeover_epoch + CASE WHEN $4 = 'human' THEN 1 ELSE 0 END,
           assigned_user_id = COALESCE($5, assigned_user_id),
           updated_at = clock_timestamp()
       WHERE id = $1 AND control_version = $2 AND status = $3
       RETURNING id, status, control_version, takeover_epoch, active_run_id`,
      [
        input.conversationId,
        input.expectedVersion,
        input.from,
        input.to,
        input.assignedUserId ?? null,
      ],
    );
    return result.rows[0] ? mapConversation(result.rows[0]) : null;
  }

  async requestCancellation(conversationId: string, expectedVersion: number): Promise<boolean> {
    return this.transaction(async (client) => {
      const conversation = await client.query<{ active_run_id: string | null }>(
        `UPDATE conversations
         SET control_version = control_version + 1, updated_at = clock_timestamp()
         WHERE id = $1 AND control_version = $2 AND status = 'ai'
         RETURNING active_run_id`,
        [conversationId, expectedVersion],
      );
      const runId = conversation.rows[0]?.active_run_id;
      if (!runId) return false;
      await client.query(
        `UPDATE ai_runs SET cancel_requested_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1 AND status IN ('creating', 'running')`,
        [runId],
      );
      await client.query(
        `INSERT INTO outbox(conversation_id, run_id, type)
         VALUES ($1, $2, 'cancel_run')`,
        [conversationId, runId],
      );
      await client.query(
        `INSERT INTO audit_events(conversation_id, actor_type, action, metadata)
         VALUES ($1, 'visitor', 'run.cancel_requested', jsonb_build_object('runId', $2::text))`,
        [conversationId, runId],
      );
      return true;
    });
  }

  async listEvents(conversationId: string, afterSequence = 0, limit = 200): Promise<EventRow[]> {
    const result = await this.pool.query<{
      id: string;
      conversation_id: string;
      run_id: string | null;
      sequence: string;
      type: EventType;
      payload: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT id, conversation_id, run_id, sequence, type, payload, created_at
       FROM conversation_events
       WHERE conversation_id = $1 AND sequence > $2
       ORDER BY sequence ASC LIMIT $3`,
      [conversationId, afterSequence, limit],
    );
    return result.rows.map(mapEvent);
  }
}

function mapConversation(row: {
  id: string;
  status: ConversationRow['status'];
  control_version: string;
  takeover_epoch: string;
  active_run_id: string | null;
}): ConversationRow {
  return {
    id: row.id,
    status: row.status,
    controlVersion: Number(row.control_version),
    takeoverEpoch: Number(row.takeover_epoch),
    activeRunId: row.active_run_id,
  };
}

function mapEvent(row: {
  id: string;
  conversation_id: string;
  run_id: string | null;
  sequence: string;
  type: EventType;
  payload: Record<string, unknown>;
  created_at: Date;
}): EventRow {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    sequence: Number(row.sequence),
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  };
}
