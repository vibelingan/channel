import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import {
  MAX_IMAGE_BYTES,
  MAX_REDIRECTS,
  fetchSourceImage,
  isBlockedAddress,
  sniffImageMime,
} from './catalog-import-media.ts';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 3),
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WEBP'),
  Buffer.alloc(64, 1),
]);

const publicHost = async () => ['203.0.113.10'];

function respond(body: Buffer, init: ResponseInit = {}): Response {
  return new Response(new Uint8Array(body), init);
}

// --- address policy ---------------------------------------------------------

test('refuses loopback, private, link-local and reserved addresses', () => {
  for (const address of [
    '127.0.0.1',
    '127.10.20.30',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata: the prize target of an SSRF
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    'ff02::1',
    '::ffff:169.254.169.254',
    '::ffff:127.0.0.1',
    'not-an-address',
  ]) {
    assert.equal(isBlockedAddress(address), true, `${address} should be blocked`);
  }
});

test('allows ordinary public addresses', () => {
  for (const address of ['203.0.113.10', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) {
    assert.equal(isBlockedAddress(address), false, `${address} should be allowed`);
  }
});

test('refuses a host that resolves to any private address', () => {
  // A host answering with one public and one private address is the classic
  // way past a check that only looks at the first answer.
  return fetchSourceImage('https://mixed.example/a.jpg', {
    resolveHost: async () => ['203.0.113.10', '127.0.0.1'],
    fetchImpl: async () => respond(JPEG),
  }).then((result) => {
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'blocked-address');
  });
});

test('refuses a host that does not resolve', async () => {
  const result = await fetchSourceImage('https://gone.example/a.jpg', {
    resolveHost: async () => {
      throw new Error('ENOTFOUND');
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'unresolvable-host');
});

test('refuses plain http, so bytes are never fetched in the clear', async () => {
  const result = await fetchSourceImage('http://cdn.example/a.jpg', {
    resolveHost: publicHost,
    fetchImpl: async () => respond(JPEG),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'not-https');
});

// --- redirects --------------------------------------------------------------

test('re-checks the address on every redirect hop', async () => {
  // The first hop is public; the redirect target is loopback. Following it
  // blindly is how an SSRF filter that only checks the original URL is beaten.
  const result = await fetchSourceImage('https://cdn.example/a.jpg', {
    resolveHost: async (hostname) =>
      hostname === 'cdn.example' ? ['203.0.113.10'] : ['127.0.0.1'],
    fetchImpl: async () =>
      respond(Buffer.alloc(0), {
        status: 302,
        headers: { location: 'https://internal.example/x' },
      }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'blocked-address');
});

test('follows a bounded number of redirects', async () => {
  let hops = 0;
  const result = await fetchSourceImage('https://cdn.example/a.jpg', {
    resolveHost: publicHost,
    fetchImpl: async () => {
      hops += 1;
      return respond(Buffer.alloc(0), {
        status: 302,
        headers: { location: `https://cdn.example/${hops}.jpg` },
      });
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'too-many-redirects');
  assert.equal(hops, MAX_REDIRECTS + 1);
});

test('follows a redirect that leads to a real image', async () => {
  let served = 0;
  const result = await fetchSourceImage('https://cdn.example/a.jpg', {
    resolveHost: publicHost,
    fetchImpl: async () => {
      served += 1;
      return served === 1
        ? respond(Buffer.alloc(0), { status: 301, headers: { location: '/final.png' } })
        : respond(PNG);
    },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.finalUrl, 'https://cdn.example/final.png');
  }
});

// --- response policy --------------------------------------------------------

test('accepts the three catalog image types by magic number', async () => {
  for (const [bytes, expected] of [
    [JPEG, 'image/jpeg'],
    [PNG, 'image/png'],
    [WEBP, 'image/webp'],
  ] as const) {
    const result = await fetchSourceImage('https://cdn.example/a', {
      resolveHost: publicHost,
      fetchImpl: async () => respond(bytes),
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.mimeType, expected);
  }
});

test('trusts magic bytes, not the supplier Content-Type header', async () => {
  // An HTML page served as image/jpeg is the whole point of sniffing.
  const result = await fetchSourceImage('https://cdn.example/a.jpg', {
    resolveHost: publicHost,
    fetchImpl: async () =>
      respond(Buffer.from('<html><script>alert(1)</script></html>'), {
        headers: { 'content-type': 'image/jpeg' },
      }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'unsupported-content');
});

test('rejects an SVG even though it is an image type', () => {
  assert.equal(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
});

test('rejects a body larger than the ceiling, declared or not', async () => {
  const declared = await fetchSourceImage('https://cdn.example/a.jpg', {
    resolveHost: publicHost,
    fetchImpl: async () =>
      respond(JPEG, { headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } }),
  });
  assert.equal(declared.ok, false);
  if (!declared.ok) assert.equal(declared.reason, 'too-large');

  const undeclared = await fetchSourceImage('https://cdn.example/a.jpg', {
    resolveHost: publicHost,
    fetchImpl: async () =>
      respond(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MAX_IMAGE_BYTES + 10)])),
  });
  assert.equal(undeclared.ok, false);
  if (!undeclared.ok) assert.equal(undeclared.reason, 'too-large');
});

test('reports an HTTP error rather than throwing', async () => {
  const result = await fetchSourceImage('https://cdn.example/a.jpg', {
    resolveHost: publicHost,
    fetchImpl: async () => respond(Buffer.alloc(0), { status: 404 }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'http-error');
});

test('reports a network failure rather than throwing', async () => {
  const result = await fetchSourceImage('https://cdn.example/a.jpg', {
    resolveHost: publicHost,
    fetchImpl: async () => {
      throw new Error('socket hang up');
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'network-error');
});

test('hashes the bytes so identical images can be deduplicated', async () => {
  const first = await fetchSourceImage('https://cdn.example/a.jpg', {
    resolveHost: publicHost,
    fetchImpl: async () => respond(JPEG),
  });
  const second = await fetchSourceImage('https://cdn.example/b.jpg', {
    resolveHost: publicHost,
    fetchImpl: async () => respond(JPEG),
  });
  assert.equal(first.ok && second.ok, true);
  if (first.ok && second.ok) {
    assert.equal(first.sha256, second.sha256, 'same bytes, same hash, one stored copy');
    assert.equal(first.sha256.length, 64);
  }
});

test('a malformed URL is reported, not thrown', async () => {
  const result = await fetchSourceImage('not a url at all');
  assert.equal(result.ok, false);
});
