import assert from 'node:assert/strict';
import test from 'node:test';
import { OEM_FILE_MAX_BYTES } from '@vibelingan-channel/shared/media';
import { readPrivateFile } from './private-file.ts';

test('private storage bytes use a server-approved host and no redirects', async () => {
  const storage = {
    getTempUrl: async () => ({ url: 'https://storage.example.invalid/drawing?private=synthetic' }),
  };
  const data = Buffer.from('synthetic bytes');
  const result = await readPrivateFile(
    storage,
    'cloud://env.bucket/file',
    ['storage.example.invalid'],
    async (_url, options) => {
      assert.equal(options?.redirect, 'error');
      assert.ok(options?.signal);
      return new Response(data);
    },
  );
  assert.deepEqual(Buffer.from(result.body, 'base64'), data);
  assert.equal(result.byteSize, data.byteLength);
});

test('foreign, non-HTTPS or credential-bearing URLs never reach fetch', async () => {
  let calls = 0;
  for (const url of [
    'http://storage.example.invalid/x',
    'https://foreign.invalid/x',
    'https://user:pass@storage.example.invalid/x',
  ]) {
    await assert.rejects(
      readPrivateFile(
        { getTempUrl: async () => ({ url }) },
        'one',
        ['storage.example.invalid'],
        async () => {
          calls++;
          return new Response('private');
        },
      ),
    );
  }
  assert.equal(calls, 0);
});

test('oversized private bodies are canceled while streaming', async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() {
      canceled = true;
    },
  });
  await assert.rejects(
    readPrivateFile(
      { getTempUrl: async () => ({ url: 'https://storage.example.invalid/x' }) },
      'one',
      ['storage.example.invalid'],
      async () => new Response(body),
    ),
  );
  assert.equal(canceled, true);
  assert.ok(OEM_FILE_MAX_BYTES >= 1024 * 1024);
});
