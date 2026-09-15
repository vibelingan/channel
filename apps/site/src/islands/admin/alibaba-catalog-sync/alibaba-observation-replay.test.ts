import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AlibabaObservationReplay } from './AlibabaObservationReplay.tsx';
import {
  type SourceObservationReplayPage,
  type SourceObservationReplayPlan,
  applySourceObservationReplay,
  decodeSourceObservationReplayPage,
  validateSourceObservationReplay,
} from './alibaba-api.ts';

const validPage: SourceObservationReplayPage = {
  ok: true,
  mode: 'dry-run',
  ready: true,
  manifestId: 'raw-replay-11111111-1111-1111-1111-111111111111',
  manifestReady: false,
  pageHash: 'a'.repeat(64),
  totalSourceProducts: 25,
  afterSourceKey: '',
  nextSourceKey: 'source-20',
  done: false,
  counts: {
    sourceProducts: 20,
    observations: 20,
    variants: 50,
    offers: 50,
    attributedVariants: 49,
    attributePairs: 90,
    warnings: 19,
  },
  priceModes: { tiered: 25, unavailable: 25 },
  failures: [],
  applied: 0,
};

const validPlan: SourceObservationReplayPlan = {
  pages: [validPage],
  counts: validPage.counts,
  priceModes: validPage.priceModes,
  ready: true,
  totalSourceProducts: 25,
  manifestId: validPage.manifestId,
};

test('replay page decoder accepts the bounded success summary', () => {
  assert.deepEqual(decodeSourceObservationReplayPage(validPage), validPage);
});

test('replay page decoder fails closed on malformed, inconsistent, or unknown data', () => {
  const malformed: unknown[] = [
    null,
    undefined,
    '',
    {},
    { ...validPage, pageHash: 'not-a-hash' },
    { ...validPage, mode: 'delete' },
    { ...validPage, counts: { ...validPage.counts, offers: -1 } },
    { ...validPage, counts: { ...validPage.counts, sourceProducts: 21 } },
    { ...validPage, unknownField: true },
    { ...validPage, counts: { ...validPage.counts, unknownCount: 1 } },
    { ...validPage, counts: { ...validPage.counts, observations: 19 } },
    { ...validPage, nextSourceKey: '' },
    { ...validPage, done: true },
    { ...validPage, priceModes: { vip: 1 } },
    { ...validPage, failures: [{ sourceKey: 'x', reason: 'invented' }] },
    { ...validPage, ready: false, failures: [] },
    { ...validPage, mode: 'dry-run', applied: 1 },
    { ...validPage, mode: 'apply', applied: 19 },
    {
      ...validPage,
      mode: 'apply',
      ready: false,
      failures: [{ sourceKey: 'x', reason: 'offer-set-mismatch' }],
      counts: { ...validPage.counts, observations: 19 },
      applied: 1,
      manifestReady: true,
    },
  ];
  for (const value of malformed) assert.equal(decodeSourceObservationReplayPage(value), null);
});

test('replay control requires validation before apply and renders safe aggregates only', () => {
  const idle = renderToStaticMarkup(
    createElement(AlibabaObservationReplay, {
      connected: true,
      busy: false,
      phase: 'idle',
      progress: null,
      plan: null,
      applied: null,
      onValidate: () => {},
      onApply: () => {},
    }),
  );
  assert.match(idle, /data-replay-apply="true"[^>]*disabled=""/);

  const validated = renderToStaticMarkup(
    createElement(AlibabaObservationReplay, {
      connected: true,
      busy: false,
      phase: 'validated',
      progress: 'Validation complete.',
      plan: validPlan,
      applied: null,
      onValidate: () => {},
      onApply: () => {},
    }),
  );
  assert.ok(validated.includes('Validation passed for 20 source products.'));
  assert.ok(validated.includes('tiered 25'));
  assert.ok(!/data-replay-apply="true"[^>]*disabled=""/.test(validated));
  assert.ok(!validated.includes('Bearer '));
  assert.ok(!validated.includes('channel.token'));
});

test('validation advances by cursor and apply reuses each exact page hash', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const requests: Array<Record<string, unknown>> = [];
  const secondDry: SourceObservationReplayPage = {
    ...validPage,
    pageHash: 'b'.repeat(64),
    afterSourceKey: validPage.nextSourceKey,
    nextSourceKey: 'source-25',
    done: true,
    manifestReady: true,
    counts: {
      sourceProducts: 5,
      observations: 5,
      variants: 8,
      offers: 8,
      attributedVariants: 8,
      attributePairs: 14,
      warnings: 5,
    },
    priceModes: { tiered: 3, unavailable: 5 },
  };
  const responses: SourceObservationReplayPage[] = [
    validPage,
    secondDry,
    { ...validPage, mode: 'apply', applied: 20, manifestReady: true },
    { ...secondDry, mode: 'apply', applied: 5, manifestReady: true },
  ];
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => 'browser-session' },
  });
  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const response = responses.shift();
    return new Response(JSON.stringify({ ok: true, data: response }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const progress: number[] = [];
    const plan = await validateSourceObservationReplay((_pages, products) =>
      progress.push(products),
    );
    assert.equal(plan.ready, true);
    assert.equal(plan.pages.length, 2);
    assert.equal(plan.counts.sourceProducts, 25);
    assert.deepEqual(progress, [20, 25]);
    assert.equal(await applySourceObservationReplay(plan), 25);
    assert.deepEqual(
      requests.map((request) => {
        const data = request.data as Record<string, unknown>;
        return [
          data.mode,
          data.afterSourceKey,
          data.expectedPageHash ?? null,
          data.expectedTotalSourceProducts ?? null,
          data.manifestId ?? null,
        ];
      }),
      [
        ['dry-run', '', null, null, null],
        ['dry-run', 'source-20', null, null, validPage.manifestId],
        ['apply', '', 'a'.repeat(64), 25, validPage.manifestId],
        ['apply', 'source-20', 'b'.repeat(64), 25, validPage.manifestId],
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('apply reports a bounded preflight reason without exposing source keys', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => 'browser-session' },
  });
  const failedPage: SourceObservationReplayPage = {
    ...validPage,
    mode: 'apply',
    ready: false,
    pageHash: 'b'.repeat(64),
    counts: { ...validPage.counts, observations: 19 },
    failures: [{ sourceKey: 'private-source-key', reason: 'offer-set-mismatch' }],
    applied: 0,
    manifestReady: true,
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, data: failedPage }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
  try {
    await assert.rejects(
      () => applySourceObservationReplay(validPlan),
      (error: unknown) => {
        assert.match(String(error), /offer-set-mismatch \(1\)/);
        assert.doesNotMatch(String(error), /private-source-key/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('malformed replay response fails closed before any apply plan exists', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => 'browser-session' },
  });
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, data: { ok: true, pageHash: null } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
  try {
    await assert.rejects(() => validateSourceObservationReplay(), /invalid page summary/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
