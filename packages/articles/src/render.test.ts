import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFragment } from 'parse5';
import { fromTiptapJSON } from './document.ts';
import { renderArticle } from './render.ts';

const doc = (...content: unknown[]) => fromTiptapJSON({ type: 'doc', content });
const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const image = {
  type: 'articleImage',
  attrs: { mediaId: 'media-1', alt: 'A USB-C hub', caption: 'Front view' },
};
const publicImage = {
  kind: 'public' as const,
  url: '/media/articles/media-1',
  mimeType: 'image/webp',
  width: 800,
  height: 600,
};

test('server rendering produces semantic readable HTML without an editor or browser', () => {
  const result = renderArticle(
    doc(
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Ports' }] },
      paragraph('USB-C & HDMI'),
    ),
    { mode: 'public', media: {} },
  );
  assert.match(result.html, /<h2[^>]*>Ports<\/h2>/);
  assert.match(result.html, /<p[^>]*>USB-C &amp; HDMI<\/p>/);
  assert.equal(result.text, 'Ports\nUSB-C & HDMI');
  const fragment = parseFragment(result.html);
  assert.equal(fragment.childNodes.length, 2);
  assert(!result.html.includes('script'));
});

test('text and link attributes cannot create elements or event handlers', () => {
  const result = renderArticle(
    doc({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: '<img src=x onerror="run()"> & text',
          marks: [
            { type: 'link', attrs: { href: 'https://example.com/?a=1&b=2', target: '_blank' } },
          ],
        },
      ],
    }),
    { mode: 'public', media: {} },
  );
  assert.match(result.html, /&lt;img/);
  assert.match(result.html, /rel="noopener noreferrer"/);
  assert(!result.html.includes('<img'));
  assert.match(result.html, /a=1&amp;b=2/);
});

test('lists, tables, line breaks and code preserve their semantics', () => {
  const result = renderArticle(
    doc(
      {
        type: 'orderedList',
        attrs: { start: 3 },
        content: [{ type: 'listItem', content: [paragraph('Third')] }],
      },
      {
        type: 'codeBlock',
        attrs: { language: 'typescript' },
        content: [{ type: 'text', text: 'if (a < b) {}' }],
      },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [paragraph('Port')] },
              { type: 'tableCell', content: [paragraph('USB-C')] },
            ],
          },
        ],
      },
    ),
    { mode: 'public', media: {} },
  );
  assert.match(result.html, /<ol start="3"><li>/);
  assert.match(result.html, /<pre><code class="language-typescript">if \(a &lt; b\)/);
  assert.match(result.html, /<table><tbody><tr><th>/);
  assert.match(result.text, /USB-C/);
});

test('published images use trusted media metadata and do not duplicate references', () => {
  const result = renderArticle(doc(image, image), {
    mode: 'public',
    media: { 'media-1': publicImage },
  });
  assert.deepEqual(result.mediaIds, ['media-1']);
  assert.match(result.html, /width="800" height="600"/);
  assert.match(result.html, /alt="A USB-C hub"/);
  assert.match(result.html, /<figcaption>Front view<\/figcaption>/);
});

test('missing, private, active-content and malformed media cannot be rendered as published images', () => {
  for (const media of [
    {},
    { 'media-1': { ...publicImage, kind: 'private-preview', url: 'blob:https://example.com/id' } },
    { 'media-1': { ...publicImage, mimeType: 'image/svg+xml' } },
    { 'media-1': { ...publicImage, width: 0 } },
    { 'media-1': { ...publicImage, url: 'javascript:run()' } },
  ])
    assert.throws(() => renderArticle(doc(image), { mode: 'public', media }));
});

test('private preview only accepts same-origin object URLs, never raw storage addresses', () => {
  const preview = {
    ...publicImage,
    kind: 'private-preview' as const,
    url: 'blob:https://admin.example/image-id',
  };
  assert.doesNotThrow(() =>
    renderArticle(doc(image), {
      mode: 'preview',
      previewOrigin: 'https://admin.example',
      media: { 'media-1': preview },
    }),
  );
  for (const url of ['https://storage.example/private', 'blob:https://other.example/image-id'])
    assert.throws(() =>
      renderArticle(doc(image), {
        mode: 'preview',
        previewOrigin: 'https://admin.example',
        media: { 'media-1': { ...preview, url } },
      }),
    );
});
