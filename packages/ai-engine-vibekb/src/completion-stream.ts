import { EngineError } from '@vibelingan-channel/ai-engine/errors';
import { record } from './http.ts';

/** OpenAI-compatible SSE: UTF-8/network chunk boundaries are not event boundaries. */
export async function* completionFrames(response: Response): AsyncGenerator<unknown> {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    yield await response.json();
    return;
  }
  if (!response.body) throw new EngineError('unavailable');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(pending);
        if (!boundary) break;
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        if (data === '[DONE]') return;
        const value: unknown = JSON.parse(data);
        if (!record(value)) throw new EngineError('invalid_request');
        yield value;
      }
      if (chunk.done)
        throw new EngineError('unavailable', { safeDetail: 'model_stream_incomplete' });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
