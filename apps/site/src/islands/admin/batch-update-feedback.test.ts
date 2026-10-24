import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BatchUpdateFeedback, retryableIds } from './BatchUpdateFeedback.tsx';
import type { BatchUpdateResult } from './api.ts';

const mixed: BatchUpdateResult = {
  updated: 3,
  items: [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }],
  failures: [
    {
      id: 'bad',
      code: 'VALIDATION_ERROR',
      message: 'Product family is required to publish',
      outcome: 'rejected',
      retryable: false,
    },
    {
      id: 'busy',
      code: 'BUSY',
      message: 'Another change happened at the same moment. Try again.',
      outcome: 'rejected',
      retryable: true,
    },
    {
      id: 'lost',
      code: 'NETWORK_ERROR',
      message:
        "Couldn't check whether it went through. Refresh the list to see, then try again if needed.",
      outcome: 'unconfirmed',
      retryable: true,
    },
    {
      id: 'later',
      code: 'NOT_ATTEMPTED',
      message: 'Not tried because the server stopped answering. Try again in a minute.',
      outcome: 'not-attempted',
      retryable: true,
    },
  ],
};

function render(props: Partial<Parameters<typeof BatchUpdateFeedback>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(BatchUpdateFeedback, {
      result: mixed,
      names: { bad: 'Unclassified lamp', busy: 'Headset', lost: 'Speaker', later: 'Charger' },
      published: true,
      onDismiss: () => {},
      ...props,
    }),
  );
}

test('the summary counts what was published, what was not, and what could not be checked', () => {
  const html = render();
  assert.match(html, /role="alert"/);
  assert.match(html, /3 published · 3 not published · 1 couldn(&#x27;|')t be checked/);
  assert.doesNotMatch(html, /need attention|Not confirmed|rolled back|Unconfirmed/);
});

test('each product says in plain words why it did not publish', () => {
  const html = render();
  assert.match(html, /<strong>Unclassified lamp<\/strong>: Product family is required to publish/);
  assert.match(html, /<strong>Headset<\/strong>: Another change happened at the same moment/);
  assert.match(html, /<strong>Charger<\/strong>: Not tried because the server stopped answering/);
  assert.match(html, /Fix the reason shown for each product \(in Edit\), then publish it again\./);
});

test('products that need no fix can be tried again in one click', () => {
  assert.deepEqual(retryableIds(mixed), ['busy', 'lost', 'later']);
  assert.match(render({ onRetry: () => {} }), />Try again for 3 products</);
  assert.match(render({ onRetry: () => {}, retrying: true }), /disabled=""[^>]*>Trying again…</);
  assert.doesNotMatch(render(), /Try again for/, 'no button without a retry action');
});

test('nothing to retry and nothing to fix: no retry button and no fix advice', () => {
  const html = render({
    result: { updated: 2, items: [{ _id: 'a' }, { _id: 'b' }], failures: [] },
    onRetry: () => {},
  });
  assert.match(html, /role="status"/);
  assert.match(html, /2 published/);
  assert.doesNotMatch(html, /Try again for|Fix the reason/);
});

test('only retryable failures: no fix advice, one retry button', () => {
  const html = render({
    result: { ...mixed, failures: mixed.failures.slice(1, 2) },
    onRetry: () => {},
  });
  assert.match(html, /3 published · 1 not published/);
  assert.match(html, />Try again for 1 product</);
  assert.doesNotMatch(html, /Fix the reason/);
});

test('disabling uses its own words', () => {
  const html = render({
    published: false,
    result: { updated: 1, items: [{ _id: 'a' }], failures: mixed.failures.slice(0, 1) },
  });
  assert.match(html, /1 disabled · 1 not disabled/);
  assert.match(html, /Fix the reason shown for each product \(in Edit\), then try it again\./);
});

test('the classification editor says how many of the selection were published', async () => {
  const { publicationMessage } = await import('./ProductClassificationEditor.tsx');
  assert.equal(
    publicationMessage(mixed),
    'Classification saved. 3 of 7 published; the others are listed below with the reason.',
  );
  assert.equal(
    publicationMessage({ updated: 2, items: [], failures: [] }),
    '2 products classified and published.',
  );
  assert.equal(
    publicationMessage({ updated: 1, items: [], failures: [] }),
    '1 product classified and published.',
  );
});

test('retry remains unavailable during readback while preserving its normal action label', () => {
  const html = render({ onRetry: () => {}, retryDisabled: true });
  assert.match(html, /disabled=""[^>]*>Try again for 3 products/);
  assert.doesNotMatch(html, /Trying again/);
  assert.doesNotMatch(
    render({ onRetry: () => {}, retryDisabled: false }),
    /disabled=""[^>]*>Try again/,
  );
});
