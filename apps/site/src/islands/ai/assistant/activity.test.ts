import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssistantActivity, activityCopy } from './AssistantActivity';
import { AssistantMessages } from './AssistantMessages';

test('immediate feedback is named, accessible and never just an ellipsis', () => {
  const html = renderToStaticMarkup(createElement(AssistantActivity, { phase: 'queued' }));
  assert.match(html, /Thinking…/);
  assert.match(html, /Getting your question ready/);
  assert.match(html, /<output/);
  assert.match(html, /aria-live="polite"/);
});

test('actual tool signals, output and recovery have distinct public descriptions', () => {
  assert.equal(
    activityCopy('reading', 'Checking public company information').title,
    'Checking company information…',
  );
  assert.equal(activityCopy('reading', 'product_search').title, 'Finding matching products…');
  assert.equal(activityCopy('reading', 'model_answer').title, 'Preparing your answer…');
  assert.equal(activityCopy('streaming', undefined, true).title, 'Writing your answer…');
  assert.equal(activityCopy('queued', 'an unverified private backend label').title, 'Thinking…');
  assert.equal(activityCopy('reconnecting').title, 'Reconnecting…');
  assert.equal(activityCopy('stopping', 'product_search').title, 'Stopping…');
});

test('an empty assistant placeholder is not rendered as an answer bubble', () => {
  const html = renderToStaticMarkup(
    createElement(AssistantMessages, {
      messages: [{ id: 'pending', role: 'assistant', text: '' }],
      onInquiry() {},
    }),
  );
  assert.doesNotMatch(html, /<article/);
});

test('real streamed text remains one message with a presentational cursor', () => {
  const html = renderToStaticMarkup(
    createElement(AssistantMessages, {
      messages: [{ id: 'answer', role: 'assistant', text: 'We help brands' }],
      streamingMessageId: 'answer',
      onInquiry() {},
    }),
  );
  assert.equal((html.match(/<article/g) ?? []).length, 1);
  assert.match(html, /We help brands/);
  assert.match(html, /assistant-writing-cursor/);
});
