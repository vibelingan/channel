import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AlibabaDraftMaterialization } from './AlibabaDraftMaterialization.tsx';

test('draft materialization explains visibility and never promises publication', () => {
  const markup = renderToStaticMarkup(
    createElement(AlibabaDraftMaterialization, {
      connected: true,
      busy: false,
      progress: { visited: 1_074, created: 1_074, existing: 0, failures: 0 },
      onMaterialize: () => {},
    }),
  );
  assert.ok(markup.includes('Make synced products visible'));
  assert.ok(markup.includes('Drafts remain unpublished'));
  assert.ok(markup.includes('1,074'));
  assert.ok(markup.includes('Create missing drafts'));
});

test('draft materialization is disabled until Alibaba is connected', () => {
  const markup = renderToStaticMarkup(
    createElement(AlibabaDraftMaterialization, {
      connected: false,
      busy: false,
      progress: null,
      onMaterialize: () => {},
    }),
  );
  assert.ok(markup.includes('disabled'));
});
