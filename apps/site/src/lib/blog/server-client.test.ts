import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { publicArticleForRender } from './server-client.ts';
import { publishedArticleFixture } from './testing.ts';

function setup(t: TestContext, enabled: string | undefined, data: unknown, status = 200) {
  const previous = {
    origin: process.env.BLOG_API_ORIGIN,
    flag: process.env.BLOG_WEB_IMAGES_ENABLED,
  };
  process.env.BLOG_API_ORIGIN = 'https://articles.example';
  if (enabled === undefined) Reflect.deleteProperty(process.env, 'BLOG_WEB_IMAGES_ENABLED');
  else process.env.BLOG_WEB_IMAGES_ENABLED = enabled;
  t.after(() => {
    for (const [key, value] of [
      ['BLOG_API_ORIGIN', previous.origin],
      ['BLOG_WEB_IMAGES_ENABLED', previous.flag],
    ] as const) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ ok: true, data }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return calls;
}

test('the default keeps the existing article request and unmodified publication', async (t) => {
  const article = publishedArticleFixture();
  const calls = setup(t, undefined, article);
  const result = await publicArticleForRender(article.content.slug);
  assert.deepEqual(result, { article, presentation: { media: {} }, format: 'legacy' });
  assert.deepEqual(calls, ['https://articles.example/api/articles/slug/manufacturing-guide']);
});

test('the enabled mode receives article and presentation in one request', async (t) => {
  const article = publishedArticleFixture();
  const data = { schemaVersion: 1, article, presentation: { media: {} } };
  const calls = setup(t, '1', data);
  const result = await publicArticleForRender(article.content.slug);
  assert.deepEqual(result, { article, presentation: { media: {} }, format: 'render-web-v1' });
  assert.deepEqual(calls, [
    'https://articles.example/api/articles/slug/manufacturing-guide?view=render-web-v1',
  ]);
});

test('a valid old backend response uses originals without a second fetch', async (t) => {
  const article = publishedArticleFixture();
  const calls = setup(t, '1', article);
  assert.equal((await publicArticleForRender(article.content.slug))?.format, 'legacy');
  assert.equal(calls.length, 1);
});

test('a malformed new response is rejected instead of hidden by an original-image retry', async (t) => {
  const article = publishedArticleFixture();
  const calls = setup(t, '1', {
    schemaVersion: 1,
    article,
    presentation: { media: {}, privateStorageUrl: 'https://untrusted.example/object' },
  });
  await assert.rejects(publicArticleForRender(article.content.slug));
  assert.equal(calls.length, 1);
});

test('a different article and an unavailable API cannot become successful fallback pages', async (t) => {
  const article = publishedArticleFixture();
  const calls = setup(t, '1', {
    schemaVersion: 1,
    article,
    presentation: { media: {} },
  });
  await assert.rejects(publicArticleForRender('different-slug'), /different URL/);
  assert.equal(calls.length, 1);
});

test('a real not-found remains not-found with no retry', async (t) => {
  const calls = setup(t, '1', null, 404);
  assert.equal(await publicArticleForRender('missing'), null);
  assert.equal(calls.length, 1);
});

test('an empty successful response is an API failure rather than a false article 404', async (t) => {
  const calls = setup(t, '1', null, 200);
  await assert.rejects(publicArticleForRender('manufacturing-guide'), /missing data/);
  assert.equal(calls.length, 1);
});

test('an invalid deployment flag fails before making requests', async (t) => {
  const calls = setup(t, 'yes', publishedArticleFixture());
  await assert.rejects(publicArticleForRender('manufacturing-guide'), /BLOG_WEB_IMAGES_ENABLED/);
  assert.equal(calls.length, 0);
});
