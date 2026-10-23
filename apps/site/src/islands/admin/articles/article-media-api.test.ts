import assert from 'node:assert/strict';
import test from 'node:test';
import { getArticleImage, uploadArticleImage } from './article-media-api.ts';

function envelope(data: unknown) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
const view = {
  mediaId: 'image',
  articleId: 'article',
  mimeType: 'image/png',
  byteSize: 1,
  width: 1,
  height: 1,
};
test('article preview bytes reject wrong identity, unknown fields and incomplete byte counts', async (t) => {
  for (const data of [
    { ...view, articleId: 'other', dataBase64: 'AA==' },
    { ...view, storageFileId: 'private', dataBase64: 'AA==' },
    { ...view, byteSize: 2, dataBase64: 'AA==' },
  ]) {
    t.mock.method(globalThis, 'fetch', async () => envelope(data));
    await assert.rejects(getArticleImage('article', 'image', new AbortController().signal), {
      code: 'INVALID_RESPONSE',
    });
    t.mock.restoreAll();
  }
});
test('a malformed signed upload never sends bytes to an untrusted HTTP target', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return envelope({
      status: 'pending',
      mediaId: 'image',
      articleId: 'article',
      expiresAt: new Date().toISOString(),
      upload: { method: 'PUT', url: 'http://untrusted.example/upload', headers: {} },
    });
  });
  await assert.rejects(
    uploadArticleImage({
      articleId: 'article',
      requestId: 'request',
      file: new File([new Uint8Array([0])], 'image.png', { type: 'image/png' }),
      signal: new AbortController().signal,
    }),
    { code: 'INVALID_RESPONSE' },
  );
  assert.equal(requests, 1);
});
