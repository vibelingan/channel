import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareArticleImport } from './import.ts';
const input = {
  idempotencyKey: 'task-1:article-1',
  externalTaskId: 'task-1',
  title: 'A useful article',
  slug: '',
  format: 'markdown',
  body: '## Ports\n\nUse **clear** text and [safe links](https://example.com).',
};
test('draft import preserves its source identity and uses the existing versioned article format', () => {
  const a = prepareArticleImport(input);
  assert.equal(a.content.body.schemaVersion, 1);
  assert.equal(a.content.title, input.title);
  assert.equal(a.source.format, 'markdown');
  assert.equal(a.requestHash, prepareArticleImport({ ...input }).requestHash);
  assert.notEqual(
    a.requestHash,
    prepareArticleImport({ ...input, title: 'Different title' }).requestHash,
  );
  assert.equal(a.content.body.document.content[0]?.type, 'heading');
});
test('unsupported content and caller-controlled permissions never silently become draft content', () => {
  for (const body of [
    '# H1',
    '<script>alert(1)</script>',
    '![image](https://example.com/a.png)',
    '- [x] task',
    'A footnote[^1]\n\n[^1]: text',
    '[bad](javascript:alert(1))',
  ])
    assert.throws(() => prepareArticleImport({ ...input, body }), body);
  for (const key of ['publish', 'actorId', 'siteId', 'collection', 'callbackUrl'])
    assert.throws(() => prepareArticleImport({ ...input, [key]: 'override' }), key);
  assert.throws(() => prepareArticleImport({ ...input, body: 'x'.repeat(128 * 1024 + 1) }));
});
test('Markdown tables, nested lists, quotations and code map to supported editor nodes', () => {
  const r = prepareArticleImport({
    ...input,
    body: '| A | B |\n| - | - |\n| One | Two |\n\n> A quote\n\n1. First\n   - Nested\n\n```js\nconst x = 1\n```',
  });
  assert.deepEqual(
    r.content.body.document.content.map((n) => n.type),
    ['table', 'blockquote', 'orderedList', 'codeBlock'],
  );
  assert.deepEqual(
    prepareArticleImport({ ...input, format: 'article-json-v1', body: r.content.body }).content
      .body,
    r.content.body,
  );
});
