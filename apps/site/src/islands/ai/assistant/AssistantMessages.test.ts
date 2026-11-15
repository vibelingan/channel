import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssistantMessages } from './AssistantMessages';

test('pending answers render no empty bubble; the existing turn status shows waiting', () => {
  const html = renderToStaticMarkup(
    createElement(AssistantMessages, {
      messages: [
        { id: 'visitor', role: 'visitor', text: 'Help me choose' },
        { id: 'answer', role: 'assistant', text: '' },
      ],
      onInquiry: () => {},
    }),
  );
  assert.match(html, /Help me choose/);
  assert.doesNotMatch(html, /data-message-role="assistant"/);
});

test('an answer appears as soon as its first text arrives', () => {
  const html = renderToStaticMarkup(
    createElement(AssistantMessages, {
      messages: [{ id: 'answer', role: 'assistant', text: 'First sentence.' }],
      onInquiry: () => {},
    }),
  );
  assert.match(html, /data-message-role="assistant"/);
  assert.match(html, /First sentence\./);
});
