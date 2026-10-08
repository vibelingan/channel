import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicSseEvent } from '@vibelingan-channel/ai-contracts';
import { type ChatMessage, isReplyTo, safeCitationUrl, withEvent } from './transcript.ts';

const origin = 'https://www.example.com';

function play(messages: ChatMessage[], events: PublicSseEvent[], messageId: string) {
  return events.reduce((current, event) => withEvent(current, event, messageId, origin), messages);
}

test('an answer that finished while nobody listened stays under its own question', () => {
  // Q2 was asked, the visitor closed the panel before its answer arrived, then
  // asked Q3. The stream for Q3 starts with Q2's whole answer.
  const transcript: ChatMessage[] = [
    { id: 'q2', role: 'visitor', text: 'Q2' },
    { id: 'a2', role: 'assistant', text: '', replyTo: 'm2' },
    { id: 'q3', role: 'visitor', text: 'Q3' },
    { id: 'a3', role: 'assistant', text: '', replyTo: 'm3' },
  ];
  const earlierFinal: PublicSseEvent = { type: 'final', sequence: 6, replyTo: 'm2', text: 'A2' };
  const after = play(
    transcript,
    [
      { type: 'token', sequence: 4, replyTo: 'm2', text: 'A2' },
      { type: 'citation', sequence: 5, replyTo: 'm2', sourceId: 'faq', title: 'FAQ', url: '/faq' },
      earlierFinal,
      { type: 'token', sequence: 7, replyTo: 'm3', text: 'A3' },
    ],
    'm3',
  );

  assert.deepEqual(after[1], {
    id: 'a2',
    role: 'assistant',
    text: 'A2',
    replyTo: 'm2',
    citations: [{ title: 'FAQ', url: 'https://www.example.com/faq' }],
  });
  assert.deepEqual(after[3], { id: 'a3', role: 'assistant', text: 'A3', replyTo: 'm3' });
  // Q2's final must not end the wait for Q3's answer.
  assert.equal(isReplyTo(earlierFinal, 'm3'), false);
  assert.equal(isReplyTo({ type: 'final', sequence: 8, replyTo: 'm3', text: 'A3' }, 'm3'), true);
});

test('an answer to a question asked on another page is dropped, not shown here', () => {
  // After a page change the transcript starts empty, but the saved cursor still
  // sits before the unfinished answer to a question asked on the old page.
  const transcript: ChatMessage[] = [
    { id: 'q3', role: 'visitor', text: 'Q3' },
    { id: 'a3', role: 'assistant', text: '', replyTo: 'm3' },
  ];
  const after = play(
    transcript,
    [
      { type: 'token', sequence: 4, replyTo: 'm2', text: 'A2' },
      { type: 'final', sequence: 5, replyTo: 'm2', text: 'A2' },
      { type: 'token', sequence: 6, replyTo: 'm3', text: 'A3' },
    ],
    'm3',
  );
  assert.deepEqual(after, [
    { id: 'q3', role: 'visitor', text: 'Q3' },
    { id: 'a3', role: 'assistant', text: 'A3', replyTo: 'm3' },
  ]);
});

test('a failed earlier answer marks only its own question', () => {
  const transcript: ChatMessage[] = [
    { id: 'a2', role: 'assistant', text: '', replyTo: 'm2' },
    { id: 'a3', role: 'assistant', text: '', replyTo: 'm3' },
  ];
  const failure: PublicSseEvent = {
    type: 'error',
    sequence: 4,
    replyTo: 'm2',
    category: 'knowledge_empty',
    retriable: false,
  };
  const after = play(transcript, [failure], 'm3');
  assert.equal(after[0]?.role, 'status');
  assert.deepEqual(after[1], { id: 'a3', role: 'assistant', text: '', replyTo: 'm3' });
  assert.equal(isReplyTo(failure, 'm3'), false);
});

test('events without replyTo still belong to the answer being waited for', () => {
  // A conversation-level event, or an event from a BFF deployed before the
  // field existed: behave exactly as before.
  const legacyToken: PublicSseEvent = { type: 'token', sequence: 1, text: 'A1' };
  const after = play(
    [{ id: 'a1', role: 'assistant', text: '', replyTo: 'm1' }],
    [legacyToken],
    'm1',
  );
  assert.equal(after[0]?.text, 'A1');
  assert.equal(isReplyTo(legacyToken, 'm1'), true);
  assert.equal(isReplyTo({ type: 'handoff.started', sequence: 2 }, 'm1'), true);
});

test('citation links keep only http and https targets', () => {
  assert.equal(safeCitationUrl('/oem', origin), 'https://www.example.com/oem');
  assert.equal(safeCitationUrl('https://site.example/faq', origin), 'https://site.example/faq');
  assert.equal(safeCitationUrl('javascript:alert(1)', origin), undefined);
  assert.equal(safeCitationUrl(undefined, origin), undefined);
});
