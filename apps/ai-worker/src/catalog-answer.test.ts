import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicProductCard } from '@vibelingan-channel/ai-contracts';
import { FakeEngine } from '@vibelingan-channel/ai-engine/fake';
import type { EngineRunRequest } from '@vibelingan-channel/ai-engine/port';
import { explainCatalog } from './catalog-answer.ts';

const request: EngineRunRequest = {
  operationId: 'catalog-prose',
  conversationRef: 'test',
  profileId: 'channel-products-v1',
  locale: 'en',
  turns: [{ role: 'visitor', text: 'Which headphone is wireless?' }],
  limits: { maxDeliveredOutputUnits: 1024, maxToolCalls: 0, maxStreamDurationMs: 1000 },
};
const products: PublicProductCard[] = [
  {
    id: 'p1',
    name: 'Headphones',
    summary: 'Wireless headphones.',
    revision: 'r1',
    href: '/products/item/?id=p1',
    retrievedAt: '2026-11-02T00:00:00Z',
  },
];

test('catalog explanation uses only server-projected sources and preserves current cards', async () => {
  const engine = new FakeEngine({
    script: [JSON.stringify({ kind: 'answer', text: 'These headphones are wireless.' })],
  });
  const result = await explainCatalog(
    engine,
    request,
    products,
    AbortSignal.timeout(1000),
    'channelkb',
  );
  assert.equal(result?.text, 'These headphones are wireless.');
  assert.equal(result?.citations[0]?.sourceId, 'channelkb/catalog/p1');
  assert.equal(result?.citations[0]?.snippet, 'Headphones\nWireless headphones.');
  assert.equal(products[0]?.revision, 'r1');
});

test('invented commercial promises and action plans fall back to existing product cards', async () => {
  for (const plan of [
    { kind: 'answer', text: 'We guarantee a price of $12 per unit.' },
    { kind: 'inquiry', summary: 'Submit it' },
  ]) {
    const result = await explainCatalog(
      new FakeEngine({ script: [JSON.stringify(plan)] }),
      request,
      products,
      AbortSignal.timeout(1000),
      'channelkb',
    );
    assert.equal(result, null);
  }
});

test('optional model creation failure falls back; cancellation is preserved', async () => {
  class BrokenEngine extends FakeEngine {
    override async createRun(): Promise<never> {
      throw new Error('provider unavailable');
    }
  }
  const engine = new BrokenEngine();
  assert.equal(
    await explainCatalog(engine, request, products, AbortSignal.timeout(1000), 'channelkb'),
    null,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(explainCatalog(engine, request, products, controller.signal, 'channelkb'));
});

test('the explanation call is billed to the same question, and a spent budget keeps the cards', async () => {
  const billed: Array<{ inputTokens: number; outputTokens: number }> = [];
  const engine = new FakeEngine();
  engine.streamRun = async function* () {
    yield { type: 'usage', usage: { inputTokens: 700, outputTokens: 25 } };
    yield {
      type: 'final',
      text: '{"kind":"answer","text":"These headphones are wireless."}',
      citations: [],
    };
  };
  const result = await explainCatalog(
    engine,
    request,
    products,
    AbortSignal.timeout(1000),
    'channelkb',
    async (usage) => {
      billed.push(usage);
    },
  );
  assert.equal(result?.text, 'These headphones are wireless.');
  assert.deepEqual(billed, [{ inputTokens: 700, outputTokens: 25 }]);
  const spent = new FakeEngine();
  spent.streamRun = async function* () {
    yield {
      type: 'error',
      category: 'quota',
      retriable: false,
      safeDetail: 'question_budget_exhausted',
    };
  };
  assert.equal(
    await explainCatalog(spent, request, products, AbortSignal.timeout(1000), 'channelkb'),
    null,
  );
});
