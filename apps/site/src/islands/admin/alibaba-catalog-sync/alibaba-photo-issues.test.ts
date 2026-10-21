import assert from 'node:assert/strict';
import test from 'node:test';
import { photoFailureText } from './AlibabaPhotoIssues.tsx';

test('photo failures explain the verified cause and do not invent an exact HTTP code', () => {
  assert.match(photoFailureText('not-found'), /denied access or no longer provides/);
  assert.match(photoFailureText('not-found'), /403\/404\/410/);
  assert.match(photoFailureText('fetch-failed'), /download failed or timed out/);
  assert.match(photoFailureText('write-failed'), /could not be saved/);
  assert.match(photoFailureText('unknown'), /Retry or replace/);
});

test('refresh from Alibaba is available only for an unpublished linked product', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { AlibabaProductRefresh } = await import('./AlibabaProductRefresh.tsx');
  const render = (overrides: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(AlibabaProductRefresh, {
        product: { _id: 'draft', alibabaSourceProductId: 'supplier-id', ...overrides },
        onRefreshed: () => {},
      }),
    );
  assert.match(render({ published: false }), /Refresh from Alibaba/);
  assert.equal(render({ published: true }), '');
  assert.equal(render({ archived: true }), '');
  assert.equal(render({ alibabaSourceProductId: '' }), '');
});
