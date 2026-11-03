import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EngineTurn } from '@vibelingan-channel/ai-engine/port';
import { fixedReply, normalizeQuestion, screenVisitorMessage } from './screen.ts';

const visitor = (text: string): EngineTurn => ({ role: 'visitor', text });
const assistant = (text: string): EngineTurn => ({ role: 'assistant', text });
const screen = (...texts: Array<string | EngineTurn>) =>
  screenVisitorMessage(texts.map((t) => (typeof t === 'string' ? visitor(t) : t)));

test('greetings and thanks get a fixed reply in any common form', () => {
  for (const text of [
    'hello',
    'Hi!!',
    'hey there',
    'Good morning',
    '你好！',
    '您好',
    '在吗？',
    'HELLO 👋',
  ])
    assert.equal(screen(text), 'greeting', text);
  for (const text of ['Thanks!', 'thank you very much', '谢谢', 'Cheers'])
    assert.equal(screen(text), 'thanks', text);
});

test('a greeting with a question in it still reaches the model', () => {
  for (const text of [
    'Hi, do you make earbuds?',
    'hello I need 500 headphones',
    '你好，有蓝牙耳机吗',
    'thanks, what about the MOQ?',
  ])
    assert.equal(screen(text), null, text);
});

test('a message with nothing to answer is asked for the need', () => {
  for (const text of ['???', '...', '😀😀', 'aaaaaa', 'asdfgh', 'qwerty'])
    assert.equal(screen(text), 'no_content', text);
  // Short business words and codes are real questions.
  for (const text of ['TWS', 'ANC', 'QCY-T13', 'OEM?', '500', 'MOQ'])
    assert.equal(screen(text), null, text);
});

test('a symbol may answer the question the assistant just asked', () => {
  assert.equal(screen('Earbuds', assistant('Shall I prepare an inquiry?'), '👍'), null);
  assert.equal(screen('Earbuds', assistant('Here are three earbuds.'), '👍'), 'no_content');
});

test('the third identical question after two answers is not sent to the model again', () => {
  const asked = 'What is the MOQ for earbuds?';
  assert.equal(screen(asked), null);
  // Asking again (a retry, or wanting a fresh answer) is allowed once.
  assert.equal(screen(asked, assistant('The MOQ is…'), asked), null);
  assert.equal(
    screen(asked, assistant('The MOQ is…'), 'what is the moq for earbuds', assistant('…'), asked),
    'repeat',
  );
  // A question that was never answered (stopped or failed) does not count.
  assert.equal(screen(asked, asked, assistant('The MOQ is…'), asked), null);
  // Anything different in between starts the count again.
  assert.equal(
    screen(asked, assistant('…'), 'And lead time?', assistant('…'), asked, assistant('…'), asked),
    null,
  );
});

test('an earlier screened message does not affect the next real question', () => {
  assert.equal(
    screen(
      'hello',
      assistant('Hello…'),
      '???',
      assistant('Please describe…'),
      'Do you make speakers?',
    ),
    null,
  );
});

test('normalizing ignores case, width, punctuation and spacing only', () => {
  assert.equal(normalizeQuestion('  What  IS the MOQ？ '), 'what is the moq');
  assert.equal(normalizeQuestion('ＭＯＱ'), 'moq');
  assert.notEqual(normalizeQuestion('MOQ for 500'), normalizeQuestion('MOQ for 5000'));
});

test('fixed replies follow the visitor language', () => {
  assert.match(fixedReply('greeting', '你好', 'en').text, /你好/);
  assert.match(fixedReply('greeting', 'hello', 'zh-CN').text, /^Hello/);
  assert.match(fixedReply('no_content', '???', 'zh-CN').text, /请描述/);
  assert.equal(fixedReply('no_content', '???', 'en').kind, 'clarification');
});
