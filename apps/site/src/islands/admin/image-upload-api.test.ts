import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { uploadImage } from './api.ts';

function fixture(t: TestContext) {
  let actor = 'u1';
  let token = 'test-token-1';
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) =>
        key === 'channel.token'
          ? token
          : key === 'channel.user'
            ? JSON.stringify({ id: actor, role: 'admin', email: 'fixture@example.invalid' })
            : null,
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  const counts = { intents: 0, puts: 0, complete: 0 };
  const completed: { imageId: string; token: string }[] = [];
  let loseCompleteReply = false;
  let afterPut: (() => void) | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    if (init.method === 'PUT') {
      counts.puts++;
      afterPut?.();
      return new Response(null, { status: 204 });
    }
    const request = JSON.parse(String(init.body));
    if (request.action === 'createUploadIntent') {
      counts.intents++;
      const id = `fixture-image-${counts.intents}`;
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            imageId: id,
            uploadIntentId: id,
            storageFileId: `local-disk:${id}`,
            upload: { method: 'PUT', url: 'https://storage.example.invalid/upload', headers: {} },
          },
        }),
      );
    }
    assert.equal(request.action, 'completeUpload');
    counts.complete++;
    completed.push({ imageId: request.data.imageId, token: request.token });
    if (loseCompleteReply) {
      loseCompleteReply = false;
      throw new TypeError('The completion reply was lost');
    }
    return new Response(
      JSON.stringify({ ok: true, data: { imageId: request.data.imageId, status: 'active' } }),
    );
  });
  return {
    counts,
    completed,
    loseReply() {
      loseCompleteReply = true;
    },
    afterPut(fn: () => void) {
      afterPut = fn;
    },
    reconnect(nextToken: string) {
      token = nextToken;
    },
    switchActor() {
      actor = 'u2';
      token = 'test-token-other';
    },
    restoreOriginalActor() {
      actor = 'u1';
      token = 'test-token-renewed';
      afterPut = undefined;
    },
  };
}

test('retry after an unknown completion outcome reuses the received image id and the already uploaded original', async (t) => {
  const f = fixture(t);
  const file = new File(['fixture'], 'photo.png', { type: 'image/png' });
  f.loseReply();
  await assert.rejects(uploadImage(file), /reply was lost/);
  assert.equal(await uploadImage(file), 'fixture-image-1');
  assert.deepEqual(f.counts, { intents: 1, puts: 1, complete: 2 });
  assert.deepEqual(
    f.completed.map((c) => c.imageId),
    ['fixture-image-1', 'fixture-image-1'],
  );
});

test('switching accounts while the original uploads stops activation and preserves the confirmed upload for its owner', async (t) => {
  const f = fixture(t);
  const file = new File(['fixture'], 'photo.png', { type: 'image/png' });
  f.afterPut(() => f.switchActor());
  await assert.rejects(uploadImage(file), /original account/);
  assert.deepEqual(f.counts, { intents: 1, puts: 1, complete: 0 });
  f.restoreOriginalActor();
  assert.equal(await uploadImage(file), 'fixture-image-1');
  assert.deepEqual(f.counts, { intents: 1, puts: 1, complete: 1 });
});

test('a reconnected original actor resumes the same image with the current token, while another actor starts its own upload', async (t) => {
  const f = fixture(t);
  const file = new File(['fixture'], 'photo.png', { type: 'image/png' });
  f.loseReply();
  await assert.rejects(uploadImage(file));
  f.reconnect('test-token-renewed');
  assert.equal(await uploadImage(file), 'fixture-image-1');
  assert.equal(f.completed.at(-1)?.token, 'test-token-renewed');
  f.switchActor();
  assert.equal(await uploadImage(file), 'fixture-image-2');
  assert.deepEqual(f.counts, { intents: 2, puts: 2, complete: 3 });
});

test('two calls for the same file and actor share one in-flight image upload', async (t) => {
  const f = fixture(t);
  const file = new File(['fixture'], 'photo.png', { type: 'image/png' });
  assert.deepEqual(await Promise.all([uploadImage(file), uploadImage(file)]), [
    'fixture-image-1',
    'fixture-image-1',
  ]);
  assert.deepEqual(f.counts, { intents: 1, puts: 1, complete: 1 });
});
