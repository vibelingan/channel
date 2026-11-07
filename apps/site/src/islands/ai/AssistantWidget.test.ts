import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnswerBody } from './AssistantWidget.tsx';

const component = new URL('./AssistantWidget.tsx', import.meta.url);

test('the chat transcript follows newly rendered messages without scrolling the page', async () => {
  const source = await readFile(component, 'utf8');
  assert.match(source, /ref=\{transcriptRef\}/);
  assert.match(source, /transcript\.scrollTo\(\{\s*top:\s*transcript\.scrollHeight/);
  assert.match(source, /\[open, status, transcriptVersion\]/);
});

test('an answer that has not arrived yet names the wait instead of showing a bare ellipsis', () => {
  const waiting = renderToStaticMarkup(createElement(AnswerBody, { text: '' }));
  assert.match(waiting, /Checking approved sources/);
  assert.doesNotMatch(waiting, /^<p[^>]*>…<\/p>$/);
  // The decoration must not be announced; the sentence carries the meaning.
  assert.match(waiting, /aria-hidden="true"/);
  // Dots animate only when the visitor has not asked for reduced motion.
  assert.match(waiting, /motion-safe:animate-bounce/);
});

test('an arrived answer renders its text and no waiting indicator', () => {
  const answered = renderToStaticMarkup(
    createElement(AnswerBody, { text: 'Our MOQ depends on the product family.' }),
  );
  assert.match(answered, /Our MOQ depends on the product family\./);
  assert.doesNotMatch(answered, /Checking approved sources/);
});
