import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ArticleValidationError,
  fromTiptapJSON,
  parseArticleDocument,
  toTiptapJSON,
} from './document.ts';

const paragraph = (text = 'Hello') => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const document = (...content: unknown[]) => ({ type: 'doc', content });

test('editor JSON round-trips without dropping text, marks or supported layout', () => {
  const input = document(
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Heading', marks: [{ type: 'bold' }] }],
    },
    paragraph(),
  );
  const parsed = fromTiptapJSON(input);
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(fromTiptapJSON(toTiptapJSON(parsed)), parsed);
  assert.deepEqual(input.content[1], paragraph());
});

for (const [label, input] of [
  ['unknown version', { schemaVersion: 2, document: document() }],
  [
    'unknown node',
    { schemaVersion: 1, document: document({ type: 'siteAction', attrs: { action: 'quote' } }) },
  ],
  [
    'unknown mark',
    {
      schemaVersion: 1,
      document: document({
        type: 'paragraph',
        content: [{ type: 'text', text: 'text', marks: [{ type: 'script' }] }],
      }),
    },
  ],
  [
    'arbitrary HTML attribute',
    { schemaVersion: 1, document: document({ type: 'paragraph', attrs: { onclick: 'run()' } }) },
  ],
  [
    'H1 in body',
    { schemaVersion: 1, document: document({ type: 'heading', attrs: { level: 1 }, content: [] }) },
  ],
  [
    'text at document root',
    { schemaVersion: 1, document: document({ type: 'text', text: 'bad position' }) },
  ],
  [
    'raw image URL',
    {
      schemaVersion: 1,
      document: document({
        type: 'articleImage',
        attrs: { src: 'https://private.example/file', alt: 'image' },
      }),
    },
  ],
] as const)
  test(`document refuses ${label}`, () =>
    assert.throws(() => parseArticleDocument(input), ArticleValidationError));

for (const href of [
  'javascript:alert(1)',
  'data:text/html,bad',
  '//evil.example',
  '/\\evil.example',
  'https://example.com/\nscript',
  'http://example.com',
  ' https://example.com',
]) {
  test(`document refuses unsafe link ${JSON.stringify(href)}`, () => {
    assert.throws(
      () =>
        fromTiptapJSON(
          document({
            type: 'paragraph',
            content: [{ type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href } }] }],
          }),
        ),
      ArticleValidationError,
    );
  });
}

test('simple tables accept rectangular cells and reject spans, ragged rows and nested unknown attributes', () => {
  const cell = { type: 'tableCell', content: [paragraph('Cell')] };
  const row = { type: 'tableRow', content: [cell, cell] };
  assert.doesNotThrow(() => fromTiptapJSON(document({ type: 'table', content: [row, row] })));
  assert.throws(
    () =>
      fromTiptapJSON(
        document({ type: 'table', content: [row, { type: 'tableRow', content: [cell] }] }),
      ),
    ArticleValidationError,
  );
  assert.throws(
    () =>
      fromTiptapJSON(
        document({
          type: 'table',
          content: [{ type: 'tableRow', content: [{ ...cell, attrs: { colspan: 2 } }] }],
        }),
      ),
    ArticleValidationError,
  );
});

test('cyclic, oversized and deeply nested input fails before recursive schema parsing', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => fromTiptapJSON(cycle), ArticleValidationError);
  let deep: unknown = paragraph();
  for (let i = 0; i < 40; i++) deep = { type: 'blockquote', content: [deep] };
  assert.throws(() => fromTiptapJSON(document(deep)), ArticleValidationError);
  assert.throws(
    () => fromTiptapJSON(document(paragraph('中'.repeat(200000)))),
    ArticleValidationError,
  );
  assert.throws(
    () => fromTiptapJSON(document(...Array.from({ length: 21000 }, () => paragraph()))),
    ArticleValidationError,
  );
});

test('shared non-cyclic objects are valid and getters are never executed', () => {
  const shared = paragraph();
  assert.doesNotThrow(() => fromTiptapJSON(document(shared, shared)));
  let accessed = false;
  const input = {
    get type() {
      accessed = true;
      return 'doc';
    },
  };
  assert.throws(() => fromTiptapJSON(input), ArticleValidationError);
  assert.equal(accessed, false);
});

test('sparse arrays cannot bypass the input budget before serialization', () => {
  assert.throws(
    () => fromTiptapJSON({ type: 'doc', content: new Array(100000000) }),
    ArticleValidationError,
  );
});

test('nested tables and duplicate text marks fail instead of losing their formatting', () => {
  const inner = {
    type: 'table',
    content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph()] }] }],
  };
  const outer = {
    type: 'table',
    content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [inner] }] }],
  };
  assert.throws(() => fromTiptapJSON(document(outer)), ArticleValidationError);
  assert.throws(
    () =>
      fromTiptapJSON(
        document({
          type: 'paragraph',
          content: [{ type: 'text', text: 'bold', marks: [{ type: 'bold' }, { type: 'bold' }] }],
        }),
      ),
    ArticleValidationError,
  );
});
