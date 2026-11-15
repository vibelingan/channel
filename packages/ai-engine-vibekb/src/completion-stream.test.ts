import assert from 'node:assert/strict';
import test from 'node:test';
import { completionFrames } from './completion-stream.ts';

test('SSE handles byte-split Chinese, CRLF, comments and the completion sentinel', async () => {
  const bytes = new TextEncoder().encode(
    ': heartbeat\r\n\r\ndata: {"text":"你好"}\r\n\r\ndata: [DONE]\n\n',
  );
  let offset = 0;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (offset < bytes.length) controller.enqueue(bytes.slice(offset, ++offset));
        else controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
  const actual = [];
  for await (const frame of completionFrames(response)) actual.push(frame);
  assert.deepEqual(actual, [{ text: '你好' }]);
  assert.equal(response.body?.locked, false);
});

test('a broken stream is not accepted as a completed response, and early return cancels the reader', async () => {
  const truncated = new Response('data: {"text":"partial"}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
  await assert.rejects(async () => {
    for await (const _ of completionFrames(truncated)) {
    }
  });
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"text":"one"}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
  for await (const _ of completionFrames(response)) break;
  assert.equal(cancelled, true);
  assert.equal(response.body?.locked, false);
});
