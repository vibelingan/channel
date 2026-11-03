import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { FakeEngine } from '@vibelingan-channel/ai-engine/fake';
import {
  type EngineEvent,
  type EngineRunRequest,
  QUESTION_BUDGET_EXHAUSTED,
} from '@vibelingan-channel/ai-engine/port';
import { AiStore, migrateUp } from '@vibelingan-channel/ai-store';
import { PublicCatalog } from './product-workflow.ts';
import { BUDGET_REPLY, type WorkerConfig, processOne } from './worker.ts';

/**
 * MIU 19: the requirement summary, the context budget and usage, through the
 * real worker and database. The model is scripted per question.
 */
const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is required for worker integration tests';
const store = databaseUrl ? new AiStore(databaseUrl, 10) : null;
const catalog = new PublicCatalog('https://catalog.invalid', async () => {
  throw new Error('No catalog read expected');
});
const config: WorkerConfig = {
  catalog,
  pollMs: 5,
  leaseSeconds: 30,
  maxAttempts: 3,
  profileId: 'channel-public-v1',
  maxDeliveredOutputUnits: 4096,
  maxStreamDurationMs: 1_000,
  maxToolCalls: 0,
  approvedSourcePrefix: 'channelkb',
  citationSiteOrigin: 'https://site.example',
};
const citations = [
  {
    sourceId: 'channelkb/company',
    title: 'Company',
    snippet: 'We make audio products.',
    retrievedAt: '2026-11-03T00:00:00.000Z',
  },
];

/** Answers one question with these events and remembers what it was asked. */
function scripted(events: EngineEvent[]) {
  const engine = new FakeEngine();
  const requests: EngineRunRequest[] = [];
  const createRun = engine.createRun.bind(engine);
  engine.createRun = async (request, signal) => {
    requests.push(structuredClone(request));
    return createRun(request, signal);
  };
  engine.streamRun = async function* () {
    yield* events;
  };
  return { engine, requests };
}
const answer = (plan: Record<string, unknown>): EngineEvent => ({
  type: 'final',
  text: JSON.stringify({ kind: 'answer', text: 'We make audio products.', ...plan }),
  citations,
});

before(async () => {
  if (store) await migrateUp(store.pool);
});
after(async () => {
  await store?.close();
});

async function ask(
  conversationId: string,
  key: string,
  content: string,
  events: EngineEvent[],
  extra: Partial<WorkerConfig> = {},
) {
  assert.ok(store);
  await store.appendVisitorMessage({
    conversationId,
    idempotencyKey: key,
    content,
    engineId: 'fake',
    engineVersion: '0.1.0',
  });
  const run = scripted(events);
  assert.equal(await processOne(store, run.engine, { ...config, ...extra }), 'processed');
  return { request: run.requests[0], final: (await store.listEvents(conversationId)).at(-1) };
}

test(
  'thirty turns later the summary still has 700 and Germany, and old turns are not resent',
  { skip },
  async () => {
    assert.ok(store);
    const { id } = await store.createConversation();
    const small = { historyTokens: 300 };
    await ask(
      id,
      'memory-01',
      'We need 500 bluetooth speakers shipped to Germany',
      [
        answer({
          need: { product: 'bluetooth speakers', quantity: '500', destination: 'Germany' },
        }),
      ],
      small,
    );
    await ask(
      id,
      'memory-02',
      'Actually make it 700',
      [answer({ need: { quantity: '700' } })],
      small,
    );
    let last: Awaited<ReturnType<typeof ask>> | undefined;
    for (let turn = 3; turn <= 30; turn++) {
      last = await ask(
        id,
        `memory-${String(turn).padStart(2, '0')}`,
        `Question ${turn} about colours and battery life of the speakers`,
        // A model re-reading old history proposes 500 again: it must not stick.
        [answer(turn === 20 ? { need: { quantity: '500' } } : {})],
        small,
      );
    }
    const memory = last?.request?.memory ?? '';
    assert.match(memory, /"quantity":\{"value":"700","basis":"stated"\}/);
    assert.match(memory, /"destination":\{"value":"Germany","basis":"stated"\}/);
    assert.doesNotMatch(memory, /500/);
    const sent = JSON.stringify(last?.request?.turns);
    assert.doesNotMatch(sent, /shipped to Germany/, 'the first turn no longer fits');
    assert.match(sent, /Question 30/);
    const stored = await store.pool.query('SELECT need_state FROM conversations WHERE id=$1', [id]);
    assert.equal(stored.rows[0].need_state.quantity.turn, 2, 'the change came from message 2');
    assert.equal(stored.rows[0].need_state.version, 2);
  },
);

test('another visitor never sees this conversation’s requirements', { skip }, async () => {
  assert.ok(store);
  const first = await store.createConversation();
  const second = await store.createConversation();
  await ask(first.id, 'isolation-a1', 'We need 900 earbuds for France', [
    answer({ need: { quantity: '900', destination: 'France' } }),
  ]);
  const other = await ask(second.id, 'isolation-b1', 'Do you make speakers?', [answer({})]);
  assert.equal(other.request?.memory, undefined);
  assert.doesNotMatch(JSON.stringify(other.request), /900|France/);
});

const usageOf = async (key: string) =>
  (
    await store?.pool.query(
      `SELECT r.usage FROM ai_runs r JOIN conversation_messages m ON m.answered_by_run = r.id
       WHERE m.idempotency_key = $1`,
      [key],
    )
  )?.rows[0]?.usage;

test('usage is summed over every call of a question', { skip }, async () => {
  assert.ok(store);
  const { id } = await store.createConversation();
  const { request } = await ask(id, 'usage-q4', 'Tell me about your company and OEM process', [
    { type: 'usage', usage: { inputTokens: 1_000, outputTokens: 50 } },
    { type: 'usage', usage: { inputTokens: 1_500, outputTokens: 60 } },
    { type: 'usage', usage: { inputTokens: 800, outputTokens: 40, estimated: true } },
    { type: 'usage', usage: { inputTokens: 900, outputTokens: 70 } },
    answer({}),
  ]);
  assert.equal(request?.limits.maxInputTokens, 16_000);
  assert.equal(request?.limits.questionInputTokens, 32_000);
  assert.deepEqual(await usageOf('usage-q4'), {
    calls: 4,
    inputTokens: 4_200,
    outputTokens: 220,
    estimatedCalls: 1,
  });
});

test('calls billed before a failure stay on the record', { skip }, async () => {
  assert.ok(store);
  const { id } = await store.createConversation();
  await store.appendVisitorMessage({
    conversationId: id,
    idempotencyKey: 'usage-failed',
    content: 'Tell me about your company',
    engineId: 'fake',
    engineVersion: '0.1.0',
  });
  // Two calls are billed, then the provider drops the stream.
  const failing = scripted([
    { type: 'usage', usage: { inputTokens: 1_000, outputTokens: 50 } },
    { type: 'usage', usage: { inputTokens: 1_500, outputTokens: 60 } },
  ]);
  assert.equal(await processOne(store, failing.engine, config), 'retried');
  assert.deepEqual(await usageOf('usage-failed'), {
    calls: 2,
    inputTokens: 2_500,
    outputTokens: 110,
    estimatedCalls: 0,
  });
});

test('a spent question budget ends with a way to continue, not an error', { skip }, async () => {
  assert.ok(store);
  const { id } = await store.createConversation();
  await ask(id, 'budget-q1', 'We need 300 headphones with our logo', [
    answer({ need: { quantity: '300', product: 'headphones', customization: ['logo'] } }),
  ]);
  const { final } = await ask(id, 'budget-q2', 'Compare every certification you have', [
    { type: 'usage', usage: { inputTokens: 12_000, outputTokens: 30 } },
    { type: 'error', category: 'quota', retriable: false, safeDetail: QUESTION_BUDGET_EXHAUSTED },
  ]);
  assert.equal(final?.type, 'final');
  assert.equal(final?.payload.text, BUDGET_REPLY.en);
  assert.equal(final?.payload.kind, 'team_followup');
  assert.deepEqual(final?.payload.inquirySuggestion, {
    requirement: 'product: headphones; quantity: 300; customization: logo',
  });
  // A question that already used everything is not sent to the model at all.
  const { request } = await ask(id, 'budget-q3', 'And the warranty?', [answer({})], {
    maxInputTokensPerQuestion: 0,
  });
  assert.equal(request, undefined);
  assert.equal((await store.listEvents(id)).at(-1)?.payload.text, BUDGET_REPLY.en);
});

test(
  'follow-up suggestions skip what is known and carry the summary version',
  { skip },
  async () => {
    assert.ok(store);
    const { id } = await store.createConversation();
    const { final } = await ask(id, 'suggest-q1', 'We need 700 speakers', [
      answer({
        need: { quantity: '700', product: 'speakers' },
        suggestions: [
          { label: 'How many?', utterance: 'We need 500', kind: 'refine', about: 'quantity' },
          {
            label: 'Ship to',
            utterance: 'We ship to Germany',
            kind: 'refine',
            about: 'destination',
          },
          { label: 'Get a quote', utterance: 'Please send me a quote', kind: 'ask' },
          { label: 'Order now', utterance: 'Place the order', kind: 'submit' },
        ],
      }),
    ]);
    assert.deepEqual(final?.payload.suggestions, [
      {
        id: 's1',
        label: 'Ship to',
        utterance: 'We ship to Germany',
        kind: 'refine',
        baseCriteriaVersion: 1,
      },
      {
        id: 's2',
        label: 'Get a quote',
        utterance: 'Please send me a quote',
        kind: 'ask',
        baseCriteriaVersion: 1,
      },
    ]);
  },
);

test(
  'small talk in a row is answered without the model, warm first and never silent',
  { skip },
  async () => {
    assert.ok(store);
    const { id } = await store.createConversation();
    const silent = (): EngineEvent[] => {
      throw new Error('No model needed for small talk');
    };
    const texts: string[] = [];
    for (const [index, message] of ['Hi', 'hello?', 'Who are you?', 'hi', 'bye'].entries()) {
      await store.appendVisitorMessage({
        conversationId: id,
        idempotencyKey: `smalltalk-${index}`,
        content: message,
        engineId: 'fake',
        engineVersion: '0.1.0',
      });
      const engine = new FakeEngine();
      engine.createRun = async () => {
        silent();
        throw new Error('unreachable');
      };
      assert.equal(await processOne(store, engine, config), 'processed');
      const final = (await store.listEvents(id)).at(-1);
      assert.ok(final?.payload.screened, 'marked as a fixed reply');
      assert.ok(String(final?.payload.text).length > 0);
      texts.push(String(final?.payload.text));
      if (index !== 4) assert.equal((final?.payload.suggestions as unknown[]).length, 3);
    }
    assert.match(texts[0] ?? '', /^Hello! I can find products/);
    assert.match(texts[1] ?? '', /^Hi again/);
    assert.equal(new Set(texts.slice(2)).size, 1, 'from the third on, one steady line');
    assert.equal(await store.idleAnswerStreak(id, 10), 5);
    // A real question goes to the model and ends the streak.
    await ask(id, 'smalltalk-real', 'Do you make speakers?', [answer({})]);
    assert.equal(await store.idleAnswerStreak(id, 10), 0);
  },
);
