import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  CatalogIssueSchema,
  catalogFailureIssue,
  catalogIssueMessage,
  catalogIssuesFromZod,
  catalogValidationFailure,
  catalogValidationMessage,
} from './issues.ts';

test('supplier decisions identify the unresolved choice without mislabelling valid text or photos', () => {
  for (const [path, label] of [
    ['description', 'Description'],
    ['imageIds', 'Photos'],
    ['descriptionImageIds', 'Description photos'],
  ] as const) {
    const issue = {
      code: 'INVALID_VALUE',
      stage: 'source',
      path,
      severity: 'error',
      remedy: 'review-change',
    };
    assert.equal(
      catalogIssueMessage(issue),
      `Review the supplier change for ${label}. Choose Keep website version or Use Alibaba's before publishing.`,
    );
    assert.equal(
      catalogIssueMessage({ ...issue, remedy: 'edit' }),
      `${label} contains an invalid value.`,
    );
  }
});

test('field limits report counts and lengths without returning the rejected values', () => {
  const value = { facts: [{ name: 'PRIVATE_ATTRIBUTE', value: '秘密'.repeat(1001) }] };
  const before = structuredClone(value);
  const parsed = z
    .object({ facts: z.array(z.object({ name: z.string(), value: z.string().max(2000) })) })
    .safeParse(value);
  assert.ok(!parsed.success);
  const issues = catalogIssuesFromZod(parsed.error.issues, value, {
    stage: 'effective-content',
    remedy: 'resync',
  });
  assert.deepEqual(issues, [
    {
      code: 'TOO_LONG',
      stage: 'effective-content',
      path: 'facts.0.value',
      severity: 'error',
      remedy: 'resync',
      expected: { maxChars: 2000 },
      observed: { chars: 2002, bytes: 6006 },
    },
  ]);
  assert.equal(JSON.stringify(issues).includes('秘密'), false);
  assert.equal(JSON.stringify(issues).includes('PRIVATE_ATTRIBUTE'), false);
  assert.deepEqual(value, before);
});

test('custom messages, enum inputs and arbitrary path keys never enter a catalog issue', () => {
  const secret = 'PRIVATE_CREDENTIAL_VALUE';
  const schema = z.object({ currency: z.enum(['USD', 'CNY']) }).superRefine((_value, context) => {
    context.addIssue({ code: 'custom', path: [secret], message: secret });
  });
  const invalid = schema.safeParse({ currency: secret });
  const custom = schema.safeParse({ currency: 'USD' });
  assert.ok(!invalid.success && !custom.success);
  const issues = catalogIssuesFromZod(
    [...invalid.error.issues, ...custom.error.issues],
    {},
    { stage: 'source', remedy: 'resync' },
  );
  assert.equal(JSON.stringify(issues).includes(secret), false);
  assert.deepEqual(
    issues.map((issue) => issue.path),
    ['currency', 'field'],
  );
  for (const issue of issues) assert.equal(catalogIssueMessage(issue)?.includes(secret), false);
});

test('array count errors use absolute configuration paths and safe numeric bounds', () => {
  const value = [{ options: Array.from({ length: 51 }, () => 'private') }];
  const parsed = z.array(z.object({ options: z.array(z.string()).max(50) })).safeParse(value);
  assert.ok(!parsed.success);
  const issues = catalogIssuesFromZod(parsed.error.issues, value, {
    stage: 'effective-content',
    remedy: 'edit',
    prefix: ['variants', 'items'],
  });
  assert.deepEqual(issues, [
    {
      code: 'TOO_MANY',
      stage: 'effective-content',
      path: 'variants.items.0.options',
      severity: 'error',
      remedy: 'edit',
      expected: { maxCount: 50 },
      observed: { count: 51 },
    },
  ]);
});

test('issue decoding refuses arbitrary keys, raw messages and corrupt numeric measurements', () => {
  const issue = catalogFailureIssue('CONFLICT');
  assert.equal(CatalogIssueSchema.safeParse(issue).success, true);
  for (const invalid of [
    { ...issue, message: 'private' },
    { ...issue, path: 'PRIVATE_SOURCE_VALUE' },
    { ...issue, observed: { bytes: -1 } },
    { ...issue, expected: { maxCount: Number.POSITIVE_INFINITY } },
    { ...issue, observed: { count: Number.MAX_SAFE_INTEGER + 1 } },
    { ...issue, remedy: 'execute-script' },
    { ...issue, code: 'TOO_LONG' },
    { ...issue, code: 'TOO_MANY' },
    { ...issue, code: 'TOO_LONG', expected: { maxChars: 100 }, observed: { chars: 99 } },
    { ...issue, code: 'TOO_MANY', expected: { maxCount: 20 }, observed: { count: 20 } },
    { ...issue, code: 'TOO_LARGE', expected: { maxBytes: 100 }, observed: { bytes: 99 } },
  ]) {
    assert.equal(CatalogIssueSchema.safeParse(invalid).success, false);
    assert.equal(catalogIssueMessage(invalid), undefined);
  }
});

test('known failure codes have specific recovery actions and unknown codes remain private', () => {
  assert.equal(catalogFailureIssue('SOURCE_NOT_READY').remedy, 'resync');
  assert.equal(catalogFailureIssue('MEDIA_BUSY').remedy, 'retry-media');
  assert.equal(catalogFailureIssue('CONFLICT').remedy, 'review-change');
  assert.equal(catalogFailureIssue('UNAUTHORIZED').remedy, 'sign-in');
  assert.equal(catalogFailureIssue('APPROVAL_EXPIRED').remedy, 'review-change');
  assert.equal(
    JSON.stringify(catalogFailureIssue('PRIVATE_UNKNOWN_CODE')).includes('PRIVATE_UNKNOWN_CODE'),
    false,
  );
});

test('union diagnostics select a failing branch without leaking its values or messages', () => {
  const parsed = z
    .union([z.object({ name: z.string() }), z.object({ facts: z.array(z.string()) })])
    .safeParse({ name: 3 });
  assert.ok(!parsed.success);
  const issues = catalogIssuesFromZod(
    parsed.error.issues,
    { name: 3 },
    { stage: 'effective-content', remedy: 'edit' },
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.code, 'INVALID_VALUE');
  assert.equal(issues[0]?.path, 'name');
});

test('large diagnostic sets are explicitly bounded without losing the total issue count', () => {
  const values = Array.from({ length: 61 }, () => 'PRIVATE');
  const parsed = z.array(z.string().max(1)).safeParse(values);
  assert.ok(!parsed.success);
  const issues = catalogIssuesFromZod(parsed.error.issues, values, {
    stage: 'effective-content',
    remedy: 'resync',
    prefix: ['facts'],
  });
  const failure = catalogValidationFailure('source-candidate', issues);
  assert.equal(failure.validation.issues.length, 50);
  assert.equal(failure.validation.totalIssues, 61);
  const message = catalogValidationMessage(failure.validation);
  assert.match(message ?? '', /5 of 61/);
  assert.doesNotMatch(message ?? '', /PRIVATE/);
});

test('an arbitrary numeric record key is not mistaken for an array index', () => {
  const parsed = z.record(z.string()).safeParse({ '1234': 3 });
  assert.ok(!parsed.success);
  const issues = catalogIssuesFromZod(
    parsed.error.issues,
    { '1234': 3 },
    { stage: 'effective-content', remedy: 'edit' },
  );
  assert.equal(issues[0]?.path, 'field');
});
