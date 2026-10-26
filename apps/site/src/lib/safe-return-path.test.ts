import assert from 'node:assert/strict';
import test from 'node:test';
import {
  articleLocationPath,
  readArticleLocation,
} from '../islands/admin/articles/draft-location.ts';
import { safeReturnPath } from './safe-return-path.ts';
test('sign-in return paths remain same-origin, including encoded and slash variants', () => {
  for (const value of [
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '/\n/evil',
    '/%2f%2fevil',
    '/%255cevil',
    'javascript:alert(1)',
    ' /admin',
    '/admin\t',
  ])
    assert.equal(safeReturnPath(value), null, value);
  assert.equal(
    safeReturnPath('/admin/?section=articles&article=article-123'),
    '/admin/?section=articles&article=article-123',
  );
});
test('draft links identify one article and carry neither session nor integration credentials', () => {
  const path = articleLocationPath('article-123');
  assert.equal(readArticleLocation(path.split('?')[1] ?? ''), 'article-123');
  assert.equal(readArticleLocation('?section=articles&article=one&article=two'), null);
  assert.equal(readArticleLocation('?section=products&article=one'), null);
  assert.equal(readArticleLocation('?section=articles&article=//evil'), null);
  assert.equal(articleLocationPath(null), '/admin/?section=articles');
  assert.throws(() => articleLocationPath('not/an/id'));
});
