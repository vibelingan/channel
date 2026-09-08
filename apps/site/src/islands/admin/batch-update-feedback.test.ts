import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BatchUpdateFeedback } from './BatchUpdateFeedback.tsx';

test('partial publication exposes the failed product and reason instead of a false success', () => {
  const html = renderToStaticMarkup(
    createElement(BatchUpdateFeedback, {
      result: {
        updated: 1,
        items: [{ _id: 'ready' }],
        failures: [
          {
            id: 'bad',
            code: 'VALIDATION_ERROR',
            message: 'Product family is required to publish',
            outcome: 'rejected',
          },
        ],
      },
      names: { bad: 'Unclassified lamp' },
      published: true,
      onDismiss: () => {},
    }),
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /1 published/);
  assert.match(html, /Unclassified lamp/);
  assert.match(html, /Product family is required to publish/);
  assert.match(html, /Edit/);
});

test('uncertain results instruct refresh and never claim all items were rejected', () => {
  const html = renderToStaticMarkup(
    createElement(BatchUpdateFeedback, {
      result: {
        updated: 0,
        items: [],
        failures: [
          {
            id: 'lost',
            code: 'NETWORK_ERROR',
            message: 'Refresh before retrying',
            outcome: 'unconfirmed',
          },
        ],
      },
      names: {},
      published: false,
      onDismiss: () => {},
    }),
  );
  assert.match(html, /Not confirmed/);
  assert.match(html, /Refresh before retrying/);
});
