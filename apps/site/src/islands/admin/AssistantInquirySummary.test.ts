import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssistantInquirySummary } from './AssistantInquirySummary.tsx';
test('admin summary preserves the full confirmed requirement without interpreting HTML or offering edits', () => {
  const html = renderToStaticMarkup(
    createElement(AssistantInquirySummary, {
      value: { requirement: `${'x'.repeat(3500)}<img src=x onerror=alert(1)>` },
    }),
  );
  assert.ok(html.includes('x'.repeat(3500)));
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<input'));
  assert.ok(!html.includes('<button'));
  assert.equal(
    renderToStaticMarkup(createElement(AssistantInquirySummary, { value: undefined })),
    '',
  );
});
