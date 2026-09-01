import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import {
  MAX_IMAGE_BYTES,
  MAX_REDIRECTS,
  fetchSourceImage,
  isBlockedAddress,
  makeValidatingLookup,
  readImageDimensions,
  sniffImageMime,
} from './catalog-import-media.ts';

/**
 * Minimal but WELL-FORMED headers. The fetcher reads pixel dimensions from the
 * header, so a bare magic-number stub is now correctly refused — these carry
 * real dimensions so the tests exercise the path they mean to.
 */
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8]), // SOI
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]), // SOF0, length 17, 8-bit
  Buffer.from([0x00, 0x64]), // height 100
  Buffer.from([0x00, 0xc8]), // width 200
  Buffer.alloc(48, 7),
]);

const PNG = (() => {
  const png = Buffer.alloc(64, 3);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(200, 16);
  png.writeUInt32BE(100, 20);
  return png;
})();

const WEBP = (() => {
  const webp = Buffer.alloc(64, 1);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBP', 8, 'ascii');
  webp.write('VP8 ', 12, 'ascii');
  webp[23] = 0x9d;
  webp[24] = 0x01;
  webp[25] = 0x2a;
  webp.writeUInt16LE(200, 26);
  webp.writeUInt16LE(100, 28);
  return webp;
})();

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
    // The same IPv4-mapped addresses again, in the hex-groups form -- a
    // resolver or a crafted response can hand back either notation for the
    // identical address, and a check for only the dotted-decimal form is a
    // bypass for this one.
    '::ffff:a9fe:a9fe', // 169.254.169.254
    '::ffff:7f00:1', // 127.0.0.1
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

test('a bracketed IPv6 literal in the URL is evaluated, not just refused as unresolvable', async () => {
  // WHATWG URL.hostname keeps the brackets on a literal IPv6 host
  // ("[::1]"); assertPublicHost must strip them before the address check --
  // otherwise a literal IPv6 host is never actually judged by the blocklist,
  // it just fails as "the hostname doesn't resolve", and a PUBLIC IPv6
  // literal would be wrongly refused right alongside a blocked one.
  const blocked = await fetchSourceImage('https://[::1]/x.jpg', { resolveHost: publicHost });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.reason, 'blocked-address');

  const allowed = await fetchSourceImage('https://[2606:4700::1111]/x.jpg', {
    resolveHost: publicHost,
    fetchImpl: async () => respond(JPEG),
  });
  assert.equal(allowed.ok, true);
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

// --- streaming byte cap -----------------------------------------------------

/** A response whose body streams forever, ignoring what Content-Length claims. */
function endlessBody(headers: Record<string, string> = {}): Response {
  const chunk = new Uint8Array(64 * 1024).fill(0x41);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent += chunk.byteLength;
      // Well past the ceiling; the reader must abort long before this.
      if (sent > 80 * 1024 * 1024) controller.close();
      else controller.enqueue(chunk);
    },
  });
  return new Response(stream, { headers });
}

test('a body that streams past the ceiling is aborted mid-transfer', async () => {
  const result = await fetchSourceImage('https://cdn.example/a.jpg', {
    resolveHost: publicHost,
    fetchImpl: async () => endlessBody(),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'too-large');
    assert.match(result.detail, /aborted/);
  }
});

test('a lying Content-Length does not get past the streamed cap', async () => {
  // Declares 1 KB, then streams tens of megabytes. Checking only the header
  // would let the whole thing land in memory.
  const result = await fetchSourceImage('https://cdn.example/a.jpg', {
    resolveHost: publicHost,
    fetchImpl: async () => endlessBody({ 'content-length': '1024' }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'too-large');
});

// --- dimension limits -------------------------------------------------------

/** A PNG header declaring the given pixel dimensions; body is not decoded. */
function pngOf(width: number, height: number): Buffer {
  const png = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

test('dimensions are read from the header of each accepted format', () => {
  assert.deepEqual(readImageDimensions(pngOf(800, 600), 'image/png'), {
    width: 800,
    height: 600,
  });

  // JPEG: SOI, then a SOF0 frame declaring 480 high by 640 wide.
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),
    Buffer.from([0x01, 0xe0]),
    Buffer.from([0x02, 0x80]),
    Buffer.alloc(16),
  ]);
  assert.deepEqual(readImageDimensions(jpeg, 'image/jpeg'), { width: 640, height: 480 });

  // WebP lossy: RIFF/WEBP/VP8 with the 0x9d012a start code.
  const webp = Buffer.alloc(40);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBP', 8, 'ascii');
  webp.write('VP8 ', 12, 'ascii');
  webp[23] = 0x9d;
  webp[24] = 0x01;
  webp[25] = 0x2a;
  webp.writeUInt16LE(320, 26);
  webp.writeUInt16LE(240, 28);
  assert.deepEqual(readImageDimensions(webp, 'image/webp'), { width: 320, height: 240 });
});

test('a pixel bomb is refused on its declared dimensions, not on its size', async () => {
  // 30,000 x 30,000 is 900 megapixels — a few hundred bytes on the wire and
  // gigabytes of RAM for anything that decodes it.
  const result = await fetchSourceImage('https://cdn.example/a.png', {
    resolveHost: publicHost,
    fetchImpl: async () => new Response(new Uint8Array(pngOf(30_000, 30_000))),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'oversized-dimensions');
    assert.equal(result.detail, '30000x30000');
  }
});

test('a single oversized side is refused even within the pixel budget', async () => {
  const result = await fetchSourceImage('https://cdn.example/a.png', {
    resolveHost: publicHost,
    fetchImpl: async () => new Response(new Uint8Array(pngOf(25_000, 10))),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'oversized-dimensions');
});

test('a zero-dimension image is refused', async () => {
  const result = await fetchSourceImage('https://cdn.example/a.png', {
    resolveHost: publicHost,
    fetchImpl: async () => new Response(new Uint8Array(pngOf(0, 0))),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'oversized-dimensions');
});

test('an ordinary image passes and reports its dimensions', async () => {
  const result = await fetchSourceImage('https://cdn.example/a.png', {
    resolveHost: publicHost,
    fetchImpl: async () => new Response(new Uint8Array(pngOf(1200, 1200))),
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.dimensions, { width: 1200, height: 1200 });
});

test('a file whose dimensions cannot be located is refused, not assumed safe', async () => {
  // Valid PNG signature, truncated before IHDR.
  const stub = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const result = await fetchSourceImage('https://cdn.example/a.png', {
    resolveHost: publicHost,
    fetchImpl: async () => new Response(new Uint8Array(stub)),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'undecodable-dimensions');
});

// --- non-raster and active content -----------------------------------------

test('vector, document and markup payloads are all refused', async () => {
  const payloads: [string, Buffer][] = [
    ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')],
    ['html', Buffer.from('<!DOCTYPE html><html><body>hi</body></html>')],
    ['pdf', Buffer.from('%PDF-1.7\n1 0 obj')],
    ['gif', Buffer.from('GIF89a')],
    ['bmp', Buffer.from('BM')],
    ['zip', Buffer.from([0x50, 0x4b, 0x03, 0x04])],
    ['ico', Buffer.from([0x00, 0x00, 0x01, 0x00])],
  ];
  for (const [label, bytes] of payloads) {
    const result = await fetchSourceImage('https://cdn.example/x', {
      resolveHost: publicHost,
      // Each one is served as image/png to prove the header is not trusted.
      fetchImpl: async () =>
        new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png' } }),
    });
    assert.equal(result.ok, false, `${label} must be refused`);
    if (!result.ok) assert.equal(result.reason, 'unsupported-content', label);
  }
});

/**
 * `assertPublicHost` alone leaves a DNS-rebinding window: it resolves and
 * validates a hostname BEFORE the request is built, but `fetch` then performs
 * its own, separate resolution when it actually opens the socket. A record
 * with a short TTL can answer public on the first lookup and
 * `127.0.0.1`/`169.254.169.254` on the second, connecting to a blocked
 * address despite the earlier check passing.
 *
 * `makeValidatingLookup` closes that window by being the resolver used AT
 * CONNECT TIME (wired into `undici.Agent`'s `connect.lookup`), so the address
 * that gets validated is the address that gets connected to -- there is no
 * second, later lookup for a rebound record to answer differently to.
 */
test('the connect-time lookup refuses a hostname whose only address is blocked', async () => {
  const lookup = makeValidatingLookup(async () => ['127.0.0.1']);
  await new Promise<void>((resolve) => {
    lookup('rebinding.example', {}, (error, address) => {
      assert.ok(error instanceof Error, 'a blocked-only resolution must error, not connect');
      assert.equal(address, '');
      resolve();
    });
  });
});

test('the connect-time lookup refuses when every resolved address is blocked, even mixed', async () => {
  // A host answering one address this call happens to be all-private is still
  // refused outright -- this lookup makes no "at least one address" exception,
  // matching assertPublicHost's own "ANY blocked address refuses the host" rule.
  const lookup = makeValidatingLookup(async () => ['10.0.0.1', '192.168.1.1']);
  await new Promise<void>((resolve) => {
    lookup('all-private.example', { all: true }, (error) => {
      assert.ok(error instanceof Error);
      resolve();
    });
  });
});

test('the connect-time lookup passes only the public addresses through', async () => {
  // If a rebinding attempt mixes a public decoy with a private target, the
  // private one must never reach the caller -- filtering, not first-wins.
  const lookup = makeValidatingLookup(async () => ['203.0.113.10', '127.0.0.1']);
  await new Promise<void>((resolve) => {
    lookup('mixed.example', { all: true }, (error, addresses) => {
      assert.equal(error, null);
      const list = addresses as { address: string }[];
      assert.deepEqual(
        list.map((entry) => entry.address),
        ['203.0.113.10'],
      );
      resolve();
    });
  });
});

test('the connect-time lookup resolves fresh on every call, not from a cached earlier check', async () => {
  // Simulates a rebinding record: public on the Nth call, private after.
  let calls = 0;
  const rebinding = async () => (calls++ === 0 ? ['203.0.113.10'] : ['169.254.169.254']);
  const lookup = makeValidatingLookup(rebinding);

  await new Promise<void>((resolve) => {
    lookup('rebinds.example', {}, (error, address) => {
      assert.equal(error, null);
      assert.equal(address, '203.0.113.10');
      resolve();
    });
  });
  // The second call -- standing in for "the socket's own resolution" -- must
  // re-validate rather than trust the first call's now-stale answer.
  await new Promise<void>((resolve) => {
    lookup('rebinds.example', {}, (error) => {
      assert.ok(error instanceof Error, 'the rebound address must be refused, not connected to');
      resolve();
    });
  });
});
