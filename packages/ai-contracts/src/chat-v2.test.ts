import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { isChatEventV2, isChatTurnV2 } from './chat-v2.ts';
const event = {
  protocolVersion: 2,
  conversationId: randomUUID(),
  messageId: randomUUID(),
  runId: randomUUID(),
  controlVersion: 1,
  type: 'final',
  sequence: 1,
  text: 'An answer',
};
test('v2 rejects missing or malformed identities and unsupported event types', () => {
  assert.ok(isChatEventV2(event));
  for (const patch of [
    { runId: null },
    { conversationId: '' },
    { messageId: 4 },
    { controlVersion: Number.NaN },
    { sequence: 1.5 },
    { sequence: 0 },
    { type: 'tool.execute' },
    { text: undefined },
    { text: 'x'.repeat(32001) },
  ])
    assert.equal(isChatEventV2({ ...event, ...patch }), false);
});
test('queued and running v2 state have distinct required identities', () => {
  const state = { ...event, operationKey: randomUUID(), status: 'running', cancelRequested: false };
  assert.ok(isChatTurnV2(state));
  assert.equal(isChatTurnV2({ ...state, runId: null }), false);
  assert.ok(isChatTurnV2({ ...state, status: 'queued', runId: null, controlVersion: null }));
  assert.equal(isChatTurnV2({ ...state, operationKey: 'bad/key' }), false);
});

test('product final has bounded public paths, unique identities and a known result kind', () => {
  const card = {
    id: 'p1',
    name: 'Headphones',
    summary: 'Published',
    revision: 'v1',
    href: '/products/item/?id=p1',
    imageUrl: '/api/images/public-1',
  };
  assert.ok(
    isChatEventV2({ ...event, products: [card], kind: 'answer', unavailableProductIds: [] }),
  );
  for (const patch of [
    { products: [{ ...card, href: 'https://evil.invalid' }] },
    { products: [{ ...card, imageUrl: 'https://storage.invalid/private' }] },
    { products: [card, card] },
    { products: [{ ...card, revision: '' }] },
    { kind: 'execute' },
    { unavailableProductIds: ['../secret'] },
  ])
    assert.equal(isChatEventV2({ ...event, ...patch }), false);
});
