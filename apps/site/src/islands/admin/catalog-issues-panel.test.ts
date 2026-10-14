import assert from 'node:assert/strict';
import test from 'node:test';
import { CatalogIssueSchema } from '@vibelingan-channel/shared/catalog-issues';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CatalogIssuesPanel } from './CatalogIssuesPanel.tsx';

const issue = CatalogIssueSchema.parse({
  code: 'TOO_LONG',
  stage: 'effective-content',
  path: 'variants.items.54.sku',
  severity: 'error',
  remedy: 'resync',
  expected: { maxChars: 200 },
  observed: { chars: 201, bytes: 603 },
});
const render = (issues: readonly unknown[] = [issue]) =>
  renderToStaticMarkup(
    createElement(CatalogIssuesPanel, {
      message: 'Product preview needs attention.',
      issues,
      onRetry: () => {},
      onEdit: () => {},
    }),
  );

test('a failed website DTO is not needed to show field issues and usable repair actions', () => {
  const html = render();
  assert.match(html, /role="alert"/);
  assert.match(html, /aria-label="Product data issues"/);
  assert.match(html, /Configuration 55 SKU/);
  assert.match(html, /variants.items.54.sku/);
  assert.match(html, /201/);
  assert.match(html, /200/);
  assert.match(html, /Alibaba Sync/);
  assert.match(html, /Retry product preview/);
  assert.match(html, /Open item to repair/);
  assert.doesNotMatch(html, /data-shared-catalog-detail|Save and publish|onClick=/);
});

test('missing or malformed issues keep retry and edit without rendering private keys or values', () => {
  for (const issues of [
    [],
    [
      null,
      { ...issue, path: 'private-token' },
      { ...issue, received: 'private-source-value' },
      { ...issue, expected: { maxChars: 'private-limit' } },
    ],
  ]) {
    const html = render(issues);
    assert.match(html, /Retry product preview/);
    assert.match(html, /Open item to repair/);
    assert.doesNotMatch(html, /private-|Product data issues/);
  }
});

test('issue view bounds large reports and preserves valid numeric capacity measurements', () => {
  const tooLarge = CatalogIssueSchema.parse({
    code: 'TOO_LARGE',
    stage: 'commit',
    path: 'data',
    severity: 'error',
    remedy: 'system-repair',
    expected: { maxBytes: 524288 },
    observed: { bytes: 600000 },
  });
  const html = render(Array.from({ length: 65 }, () => tooLarge));
  assert.equal((html.match(/<li\b/g) ?? []).length, 50);
  assert.match(html, /600000/);
  assert.match(html, /524288/);
  assert.match(html, /first 50/);
});

test('a login issue has the actual sign-in recovery route and never offers publication', () => {
  const html = render([
    CatalogIssueSchema.parse({
      code: 'FORBIDDEN',
      stage: 'commit',
      path: 'product',
      severity: 'error',
      remedy: 'sign-in',
    }),
  ]);
  assert.match(html, /href="\/login\?returnTo=%2Fadmin"/);
  assert.doesNotMatch(html, /Publish|Approve/);
});
