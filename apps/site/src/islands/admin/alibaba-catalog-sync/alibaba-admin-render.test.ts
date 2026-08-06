/**
 * Presentational tests for the Alibaba operations surfaces (MIU 13):
 * connection states, run history, quarantine review, and the explicit link
 * action — plus the callback-notice mapping. Secret-free by construction:
 * assertions include that no token-ish content is ever rendered.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { callbackNotice } from './AlibabaCatalogSyncPage.tsx';
import { AlibabaConnectionPanel } from './AlibabaConnectionPanel.tsx';
import { AlibabaProductLinkAction } from './AlibabaProductLinkAction.tsx';
import { AlibabaQuarantineReview } from './AlibabaQuarantineReview.tsx';
import { AlibabaSyncRunTable } from './AlibabaSyncRunTable.tsx';

const noop = () => {};

const renderPanel = (props: Partial<Parameters<typeof AlibabaConnectionPanel>[0]> = {}): string =>
  renderToStaticMarkup(
    createElement(AlibabaConnectionPanel, {
      status: null,
      loading: false,
      busy: false,
      notice: null,
      onConnect: noop,
      onDisconnect: noop,
      onRunNow: noop,
      ...props,
    }),
  );

test('connection panel states: loading, not-connected, active, expired, not-configured', () => {
  assert.ok(renderPanel({ loading: true }).includes('Loading connection status'));

  const notConnected = renderPanel({
    status: { status: 'not_connected', notConfigured: false },
  });
  assert.ok(notConnected.includes('data-connect'));
  assert.ok(notConnected.includes('Not connected'));

  const active = renderPanel({
    status: {
      status: 'active',
      accountLabel: 'merchant@example.com',
      accessTokenExpiresAt: '2026-08-06T22:00:00.000Z',
      notConfigured: false,
    },
  });
  assert.ok(active.includes('data-run-now'));
  assert.ok(active.includes('data-disconnect'));
  assert.ok(active.includes('merchant@example.com'));
  // Only redacted METADATA renders (expiry stamp); the status payload carries
  // no credential values by construction, and none appear here.
  assert.ok(active.includes('Access token valid until 2026-08-06 22:00'));
  assert.ok(!active.includes('Bearer '), 'no credential-shaped content renders');

  const expired = renderPanel({
    status: { status: 'authorization_expired', notConfigured: false },
  });
  assert.ok(expired.includes('Authorization expired'));
  assert.ok(expired.includes('data-connect'), 'reconnect available');

  const notConfigured = renderPanel({
    status: { status: 'not_connected', notConfigured: true, missing: ['ALI_APP_KEY'] },
  });
  assert.ok(notConfigured.includes('data-not-configured'));
  assert.ok(notConfigured.includes('ALI_APP_KEY'));
  assert.ok(notConfigured.includes('disabled'), 'connect disabled while unconfigured');
});

test('run table renders rows with status badges; empty state stands alone', () => {
  assert.ok(
    renderToStaticMarkup(createElement(AlibabaSyncRunTable, { runs: [] })).includes(
      'data-alibaba-runs-empty',
    ),
  );
  const html = renderToStaticMarkup(
    createElement(AlibabaSyncRunTable, {
      runs: [
        {
          _id: 'incremental-2026-08-06',
          mode: 'incremental',
          trigger: 'timer',
          status: 'completed',
          startedAt: '2026-08-06T12:16:00.000Z',
          completedAt: '2026-08-06T12:17:00.000Z',
          errorSummary: '',
        } as CollectionDoc,
        {
          _id: 'full-2026-08-02',
          mode: 'full',
          trigger: 'manual',
          status: 'quarantined',
          startedAt: '2026-08-02T18:30:00.000Z',
          errorSummary: 'unsupported-currency',
        } as CollectionDoc,
      ],
    }),
  );
  assert.ok(html.includes('incremental-2026-08-06'));
  assert.ok(html.includes('quarantined'));
  assert.ok(html.includes('unsupported-currency'));
});

test('quarantine review lists quarantined runs and wires approval; hides when empty', () => {
  assert.equal(
    renderToStaticMarkup(
      createElement(AlibabaQuarantineReview, { runs: [], busy: false, onApprove: noop }),
    ),
    '',
  );
  const html = renderToStaticMarkup(
    createElement(AlibabaQuarantineReview, {
      runs: [
        {
          _id: 'full-2026-08-02',
          status: 'quarantined',
          candidateHash: 'c'.repeat(64),
          alerts: ['tombstone-surge'],
        } as CollectionDoc,
      ],
      busy: false,
      onApprove: noop,
    }),
  );
  assert.ok(html.includes('data-quarantined-run'));
  assert.ok(html.includes('tombstone-surge'));
  assert.ok(html.includes('data-approve-run'));
  assert.ok(html.includes('NO product changes'), 'explains the frozen state');
});

test('link action renders inputs and both explicit actions', () => {
  const html = renderToStaticMarkup(
    createElement(AlibabaProductLinkAction, {
      busy: false,
      result: 'Linked source to product p-1.',
      onLink: noop,
      onUnlink: noop,
    }),
  );
  assert.ok(html.includes('data-link-source-key'));
  assert.ok(html.includes('data-link-product-id'));
  assert.ok(html.includes('data-link-submit'));
  assert.ok(html.includes('data-unlink-submit'));
  assert.ok(html.includes('Linked source to product p-1.'));
});

test('callback notices map a CLOSED status set and never echo the query value', () => {
  assert.equal(callbackNotice(''), null);
  assert.ok(callbackNotice('?alibaba=connected')?.includes('connected successfully'));
  assert.ok(callbackNotice('?alibaba=rate-limited')?.includes('Too many'));
  assert.ok(callbackNotice('?alibaba=not-configured')?.includes('not configured'));
  assert.ok(callbackNotice('?alibaba=error-replayed-state')?.includes('already used'));
  assert.ok(callbackNotice('?alibaba=error-expired-state')?.includes('expired'));
  assert.ok(callbackNotice('?alibaba=error-exchange-failed')?.includes('token exchange'));
  // Attacker-crafted values collapse to the generic line — NO echo (R2 #12).
  const crafted = callbackNotice('?alibaba=error-%3Cimg%20src%3Dx%3E-injected');
  assert.equal(crafted, 'Authorization failed. Start the flow again.');
  assert.ok(!crafted?.includes('injected'));
});

test('callbackNotice never resolves through Object.prototype', () => {
  // A plain-object lookup would return Object.prototype / a Function here and
  // put a non-string into React's children, blanking the dashboard island.
  for (const key of ['__proto__', 'toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
    const notice = callbackNotice(`?alibaba=${encodeURIComponent(key)}`);
    assert.equal(typeof notice, 'string', `${key} must resolve to a string`);
    assert.equal(notice, 'Authorization failed. Start the flow again.');
  }
});
