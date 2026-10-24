import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  JsonNumberLexeme,
  asInteger,
  asLexeme,
  getPath,
  parseJsonPreservingNumbers,
} from './alibaba-json.ts';

const parse = (text: string) => {
  const result = parseJsonPreservingNumbers(text);
  assert.equal(result.ok, true, `expected parse ok: ${result.ok === false ? result.error : ''}`);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
};

const bad = (text: string) => {
  const result = parseJsonPreservingNumbers(text);
  assert.equal(result.ok, false, `expected parse failure for ${JSON.stringify(text)}`);
};

test('parses scalars', () => {
  assert.equal(parse('null'), null);
  assert.equal(parse('true'), true);
  assert.equal(parse('false'), false);
  assert.equal(parse('"hi"'), 'hi');
});

test('preserves number lexemes exactly', () => {
  const v = parse('1.1500000000000001');
  assert.ok(v instanceof JsonNumberLexeme);
  assert.equal(v.lexeme, '1.1500000000000001');
  const money = parse('{"price": 19.90}');
  assert.equal(asLexeme(getPath(money, ['price'])), '19.90');
});

test('parses nested structures with mixed types', () => {
  const v = parse('{"a": [1, "2", {"b": 3.50}], "c": null}');
  assert.equal(asLexeme(getPath(v, ['a', 0])), '1');
  assert.equal(asLexeme(getPath(v, ['a', 1])), '2');
  assert.equal(asLexeme(getPath(v, ['a', 2, 'b'])), '3.50');
  assert.equal(getPath(v, ['c']), null);
});

test('handles string escapes', () => {
  assert.equal(parse('"a\\n\\"b\\"\\u0041"'), 'a\n"b"A');
});

test('handles negative and exponent number lexemes', () => {
  assert.equal(asLexeme(parse('-0.5')), '-0.5');
  assert.equal(asLexeme(parse('1e10')), '1e10');
});

test('asInteger reads integer lexemes and rejects the rest', () => {
  assert.equal(asInteger(parse('42')), 42);
  assert.equal(asInteger(parse('"42"')), 42);
  assert.equal(asInteger(parse('4.2')), undefined);
  assert.equal(asInteger(parse('"abc"')), undefined);
  assert.equal(asInteger(parse('99999999999999999')), undefined);
});

test('rejects malformed JSON', () => {
  bad('');
  bad('{');
  bad('{"a"}');
  bad('[1,]');
  bad('{"a":1,}');
  bad('01');
  bad('"unterminated');
  bad('{"a":1} trailing');
  bad('undefined');
});

test('rejects unescaped control characters and bad escapes', () => {
  bad('"ab"');
  bad('"\\x41"');
  bad('"\\u12g4"');
});

test('rejects pathological nesting depth', () => {
  const deep = `${'['.repeat(100)}1${']'.repeat(100)}`;
  bad(deep);
});

test('runtime boundary rejects non-string input without throwing', () => {
  for (const value of [null, undefined, 0, false, {}, []]) {
    const result = parseJsonPreservingNumbers(value as unknown as string);
    assert.deepEqual(result, { ok: false, error: 'input must be a string' });
  }
});

test('rejects dangerous and duplicate object keys', () => {
  bad('{"__proto__":{"polluted":true}}');
  bad('{"constructor":{"prototype":{"polluted":true}}}');
  bad('{"prototype":{"polluted":true}}');
  bad('{"same":1,"same":2}');
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test('optional character cap fails before parsing oversized embedded JSON', () => {
  const result = parseJsonPreservingNumbers('{"a":1}', { maxChars: 6 });
  assert.deepEqual(result, { ok: false, error: 'input exceeds 6 characters' });
  assert.equal(parseJsonPreservingNumbers('{"a":1}', { maxChars: 7 }).ok, true);
});

test('getPath returns undefined on any miss', () => {
  const v = parse('{"a": {"b": 1}}');
  assert.equal(getPath(v, ['a', 'x']), undefined);
  assert.equal(getPath(v, ['a', 'b', 'c']), undefined);
  assert.equal(getPath(v, [0]), undefined);
  assert.equal(getPath(parse('{}'), ['toString']), undefined, 'prototype members are not data');
});
