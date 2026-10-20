import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type AlibabaSyncWorkflow, AlibabaSyncWorkflowSchema } from '@vibelingan-channel/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AlibabaCatalogSyncPage } from './AlibabaCatalogSyncPage.tsx';
import { AlibabaConnectionPanel } from './AlibabaConnectionPanel.tsx';
import { fetchSyncWorkflow, startSync } from './alibaba-api.ts';
const view: AlibabaSyncWorkflow = {
  version: 'alibaba-sync-workflow-v1',
  enabled: true,
  phase: 'idle',
  runId: null,
  startedAt: null,
  updatedAt: null,
  processed: 0,
  draftsCreated: 0,
  photosCopied: 0,
  photoIssues: 0,
  nextRetryAt: null,
  issue: null,
  history: [],
};
const noop = () => {};
test('operator page contains no diagnostic or intermediate workflow controls', () => {
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(AlibabaCatalogSyncPage, { onViewProducts: noop }),
    ),
  );
  for (const label of [
    'Website category assignment',
    'Inspect one product detail',
    'Copy photos now',
    'Make synced products visible',
    'Repair missing quotes',
    'Quarantined runs',
    'Link a source product',
    'Build common catalog data',
  ])
    assert.equal(html.includes(label), false, label);
  assert.ok(html.includes('View products'));
  assert.ok(html.includes('Recent syncs'));
});
test('operator action and phase are readable; technical status and run ID are not displayed', () => {
  const render = (workflow: AlibabaSyncWorkflow) =>
    renderToStaticMarkup(
      createElement(AlibabaConnectionPanel, {
        status: { status: 'active', notConfigured: false, accountLabel: 'Shop' },
        workflow,
        loading: false,
        busy: false,
        notice: null,
        onConnect: noop,
        onDisconnect: noop,
        onRunNow: noop,
      }),
    );
  assert.match(render(view), /Sync products/);
  const inProgress = render({
    ...view,
    phase: 'syncing',
    runId: 'internal-only-run',
    processed: 429,
  });
  assert.ok(inProgress.includes('429 products processed'));
  assert.ok(inProgress.includes('you can leave this page'));
  assert.ok(inProgress.includes('disabled'));
  assert.equal(inProgress.includes('internal-only-run'), false);
  const attention = render({ ...view, phase: 'attention', issue: 'photos', photoIssues: 3 });
  assert.ok(attention.includes('Retry sync'));
  assert.ok(attention.includes('Open Products'));
  assert.ok(attention.includes('3 products need photo review'));
});
test('normal sync start issues exactly one mutation and status uses the read-only action', async () => {
  const original = globalThis.fetch;
  const actions: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    actions.push(body.action);
    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          ...view,
          phase: body.action === 'startSync' ? 'queued' : 'syncing',
          runId: 'same-run',
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    assert.equal((await startSync()).runId, 'same-run');
    assert.equal((await fetchSyncWorkflow()).phase, 'syncing');
    assert.deepEqual(actions, ['startSync', 'workflowStatus']);
  } finally {
    globalThis.fetch = original;
  }
});
test('malformed or unexpected status never becomes a completed sync', async () => {
  assert.equal(
    AlibabaSyncWorkflowSchema.safeParse({ ...view, phase: 'continuing' }).success,
    false,
  );
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, data: { ...view, processed: -1, phase: 'complete' } }));
  try {
    await assert.rejects(fetchSyncWorkflow(), /could not be confirmed/);
  } finally {
    globalThis.fetch = original;
  }
});
