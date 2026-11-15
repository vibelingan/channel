import assert from 'node:assert/strict';
import test from 'node:test';
import { type DefaultTreeAdapterMap, parseFragment } from 'parse5';
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

test('only the opening public image position is eager and high priority', () => {
  const content = doc(image, paragraph('Inspect the sample before ordering.'), image, {
    ...image,
    attrs: { ...image.attrs, mediaId: 'media-2', alt: 'Inspection checklist', caption: '' },
  });
  const before = JSON.stringify(content);
  const result = renderArticle(content, {
    mode: 'public',
    media: {
      'media-1': publicImage,
      'media-2': { ...publicImage, url: '/media/articles/media-2' },
    },
  });
  assert.deepEqual(imageAttributes(result.html), [
    {
      src: '/media/articles/media-1',
      alt: 'A USB-C hub',
      width: '800',
      height: '600',
      loading: 'eager',
      fetchpriority: 'high',
      decoding: 'async',
    },
    {
      src: '/media/articles/media-1',
      alt: 'A USB-C hub',
      width: '800',
      height: '600',
      loading: 'lazy',
      decoding: 'async',
    },
    {
      src: '/media/articles/media-2',
      alt: 'Inspection checklist',
      width: '800',
      height: '600',
      loading: 'lazy',
      decoding: 'async',
    },
  ]);
  assert.equal(JSON.stringify(content), before);
  assert.equal(
    result.text,
    'Front view\nInspect the sample before ordering.\nFront view\nInspection checklist',
  );
  assert.deepEqual(result.mediaIds, ['media-1', 'media-2']);
  assert.match(result.html, /class="article-image article-image-center"/);
  assert.match(result.html, /<figcaption>Front view<\/figcaption>/);
});

test('empty opening text blocks do not hide an opening public image', () => {
  const result = renderArticle(
    doc(
      { type: 'paragraph', content: [] },
      paragraph(' \t '),
      { type: 'heading', attrs: { level: 2 }, content: [] },
      image,
    ),
    { mode: 'public', media: { 'media-1': publicImage } },
  );
  assert.match(result.html, /^<p><\/p><p> \t <\/p><h2><\/h2><figure/);
  assert.equal(imageAttributes(result.html)[0]?.loading, 'eager');
  assert.equal(imageAttributes(result.html)[0]?.fetchpriority, 'high');
});

test('an image following visible prose or a heading remains lazy', () => {
  for (const opening of [
    paragraph('A long introduction. '.repeat(100)),
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Inspection' }] },
  ]) {
    const result = renderArticle(doc(opening, image, image), {
      mode: 'public',
      media: { 'media-1': publicImage },
    });
    assert(imageAttributes(result.html).every((attrs) => attrs.loading === 'lazy'));
    assert(!result.html.includes('fetchpriority'));
  }
});

test('an image nested in a first block does not receive opening-image priority', () => {
  const result = renderArticle(doc({ type: 'blockquote', content: [image] }, image), {
    mode: 'public',
    media: { 'media-1': publicImage },
  });
  assert.match(result.html, /^<blockquote><figure/);
  assert(imageAttributes(result.html).every((attrs) => attrs.loading === 'lazy'));
  assert(!result.html.includes('fetchpriority'));
});

test('visible opening rules and explicit line breaks keep following images lazy', () => {
  for (const opening of [
    { type: 'horizontalRule' },
    { type: 'paragraph', content: [{ type: 'hardBreak' }] },
  ]) {
    const result = renderArticle(doc(opening, image), {
      mode: 'public',
      media: { 'media-1': publicImage },
    });
    assert.equal(imageAttributes(result.html)[0]?.loading, 'lazy');
    assert(!result.html.includes('fetchpriority'));
  }
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
  for (const media of [preview, publicImage]) {
    const result = renderArticle(doc(image, image), {
      mode: 'preview',
      previewOrigin: 'https://admin.example',
      media: { 'media-1': media },
    });
    assert(imageAttributes(result.html).every((attrs) => attrs.loading === 'lazy'));
    assert(!result.html.includes('fetchpriority'));
  }
  for (const url of ['https://storage.example/private', 'blob:https://other.example/image-id'])
    assert.throws(() =>
      renderArticle(doc(image), {
        mode: 'preview',
        previewOrigin: 'https://admin.example',
        media: { 'media-1': { ...preview, url } },
      }),
    );
});

function imageAttributes(html: string): Record<string, string>[] {
  const images: Record<string, string>[] = [];
  function visit(node: DefaultTreeAdapterMap['node']) {
    if ('tagName' in node && node.tagName === 'img')
      images.push(Object.fromEntries(node.attrs.map(({ name, value }) => [name, value])));
    if ('childNodes' in node) node.childNodes.forEach(visit);
  }
  visit(parseFragment(html));
  return images;
}
