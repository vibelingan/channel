import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LegacyTranscript } from './AssistantWidget';

const component = new URL('./AssistantWidget.tsx', import.meta.url);

test('the chat transcript follows newly rendered messages without scrolling the page', async () => {
  const source = await readFile(component, 'utf8');
  assert.match(source, /ref=\{transcriptRef\}/);
  assert.match(source, /transcript\.scrollTo\(\{\s*top:\s*transcript\.scrollHeight/);
  assert.match(source, /\[open, status, transcriptVersion\]/);
});

test('pending assistant records produce no empty bubble or standalone ellipsis', () => {
  const html = renderToStaticMarkup(
    createElement(LegacyTranscript, {
      messages: [
        { id: 'visitor', role: 'visitor', text: 'What do you provide?' },
        { id: 'pending', role: 'assistant', text: '' },
        { id: 'whitespace', role: 'assistant', text: '  \n ' },
      ],
    }),
  );
  assert.match(html, /What do you provide\?/);
  assert.doesNotMatch(html, /data-message-role="assistant"/);
  assert.doesNotMatch(html, /…/);
});

test('received answer text and source links remain in the transcript', () => {
  const html = renderToStaticMarkup(
    createElement(LegacyTranscript, {
      messages: [
        {
          id: 'answer',
          role: 'assistant',
          text: 'We provide OEM electronics.',
          citations: [{ title: 'Company capabilities', url: 'https://example.com/capabilities/' }],
        },
      ],
    }),
  );
  assert.match(html, /data-message-role="assistant"/);
  assert.match(html, /We provide OEM electronics\./);
  assert.match(html, /href="https:\/\/example\.com\/capabilities\/"/);
});
