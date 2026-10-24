import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { EngineCitation } from '@vibelingan-channel/ai-engine';
import { normalizeCitationUrl, normalizeCitations } from './citations.ts';

const policy = { siteOrigin: 'https://diversity.example' };

test('a relative path resolves against the WEBSITE, not the assistant', () => {
  // The defect: a browser resolved "/headphones" against the assistant's own
  // hostname, which serves nothing, so every source link was broken.
  assert.equal(normalizeCitationUrl('/headphones', policy), 'https://diversity.example/headphones');
});

test('an absolute first-party URL is kept', () => {
  assert.equal(
    normalizeCitationUrl('https://diversity.example/oem', policy),
    'https://diversity.example/oem',
  );
});

const REJECTED: [string, string][] = [
  ['javascript:', 'javascript:alert(1)'],
  ['data:', 'data:text/html,<script>alert(1)</script>'],
  ['file:', 'file:///etc/passwd'],
  ['plain http', 'http://diversity.example/oem'],
  ['another host', 'https://evil.example/oem'],
  ['lookalike suffix', 'https://diversity.example.evil.test/oem'],
  ['scheme-relative', '//evil.example/oem'],
  ['credentials in the URL', 'https://user:pass@diversity.example/oem'],
  ['empty', ''],
  ['whitespace', '   '],
];

for (const [name, url] of REJECTED) {
  test(`rejected: ${name}`, () => {
    assert.equal(normalizeCitationUrl(url, policy), null, `accepted ${url}`);
  });
}

test('a lookalike host is rejected by exact match, not a suffix check', () => {
  // A suffix check would accept this, which is the entire trick.
  assert.equal(normalizeCitationUrl('https://notdiversity.example/x', policy), null);
  assert.equal(normalizeCitationUrl('https://diversity.example.evil.test/x', policy), null);
});

test('a citation with an unusable link keeps its title and loses the link', () => {
  // Dropping the whole citation would hide which document answered; silently
  // repairing the URL would make an unverified destination look checked.
  const citations: EngineCitation[] = [
    { sourceId: '/a', title: 'Headphones', url: 'javascript:alert(1)', retrievedAt: 'now' },
    { sourceId: '/b', title: 'OEM', url: '/oem', retrievedAt: 'now' },
  ];
  const normalized = normalizeCitations(citations, policy);
  assert.equal(normalized[0]?.title, 'Headphones');
  assert.equal('url' in (normalized[0] ?? {}), false, 'an unsafe link survived');
  assert.equal(normalized[1]?.url, 'https://diversity.example/oem');
});

test('a missing url is not invented', () => {
  const normalized = normalizeCitations(
    [{ sourceId: '/a', title: 'Headphones', retrievedAt: 'now' }],
    policy,
  );
  assert.equal('url' in (normalized[0] ?? {}), false);
});

test('a malformed site origin drops links rather than throwing', () => {
  assert.equal(normalizeCitationUrl('/x', { siteOrigin: 'not a url' }), null);
});

/**
 * The development stack is http://localhost:4321, and requiring https outright
 * dropped every link in it — the assistant showed source titles that went
 * nowhere. These four pin the narrow exception open and everything else shut.
 */
const localPolicy = { siteOrigin: 'http://localhost:4321' };

test('a link on the local http website keeps its link', () => {
  assert.equal(
    normalizeCitationUrl('/headphones', localPolicy),
    'http://localhost:4321/headphones',
  );
});

test('an https website never accepts an http link, so a downgrade cannot sneak in', () => {
  assert.equal(normalizeCitationUrl('http://diversity.example/x', policy), null);
});

test('http is allowed for localhost only, never for another host', () => {
  assert.equal(normalizeCitationUrl('/x', { siteOrigin: 'http://kb.internal:3001' }), null);
});

test('the localhost exception does not admit javascript: links', () => {
  assert.equal(normalizeCitationUrl('javascript:alert(1)', localPolicy), null);
});
