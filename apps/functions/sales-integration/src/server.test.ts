import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { z } from 'zod';
import { createSalesServer } from './server.ts';
import { setup } from './test-fixtures.ts';

test('loopback HTTP exercises authentication, source projection and binary download', async () => {
  const s = setup();
  const server = createSalesServer(s.handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const request = s.request();
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers))
      if (typeof value === 'string') headers[name] = value;
    const response = await fetch(`${origin}${request.url}`, { headers });
    assert.equal(response.status, 200);
    const view = z
      .object({ data: z.object({ assets: z.array(z.object({ ref: z.string() })).nonempty() }) })
      .parse(await response.json());
    const attachment = await fetch(
      `${origin}/integrations/sales/assets/${view.data.assets[0].ref}`,
      { headers },
    );
    assert.equal(attachment.status, 200);
    assert.deepEqual(Buffer.from(await attachment.arrayBuffer()), s.pdf);
    const large = Buffer.concat([s.pdf, Buffer.alloc(2 * 1024 * 1024, 1)]);
    s.setDownload(large);
    s.rows.set('files/drawing_a', {
      ...s.file,
      byteSize: large.byteLength,
      checksumSha256: createHash('sha256').update(large).digest('hex'),
    });
    const largeView = z
      .object({ data: z.object({ assets: z.array(z.object({ ref: z.string() })).nonempty() }) })
      .parse(await (await fetch(`${origin}${request.url}`, { headers })).json());
    const largeResponse = await fetch(`${origin}/assets/${largeView.data.assets[0].ref}`, {
      headers,
    });
    assert.equal(largeResponse.status, 200);
    assert.deepEqual(Buffer.from(await largeResponse.arrayBuffer()), large);
    const maximum = Buffer.concat([s.pdf, Buffer.alloc(10 * 1024 * 1024 - s.pdf.byteLength, 2)]);
    s.setDownload(maximum);
    s.rows.set('files/drawing_a', {
      ...s.file,
      byteSize: maximum.byteLength,
      checksumSha256: createHash('sha256').update(maximum).digest('hex'),
    });
    const maximumView = z
      .object({ data: z.object({ assets: z.array(z.object({ ref: z.string() })).nonempty() }) })
      .parse(await (await fetch(`${origin}${request.url}`, { headers })).json());
    const assetUrl = `${origin}/assets/${maximumView.data.assets[0].ref}`;
    const unbounded = await fetch(assetUrl, { headers });
    assert.equal(unbounded.status, 413);
    assert.equal(
      z.object({ code: z.string() }).parse(await unbounded.json()).code,
      'ASSET_RANGE_REQUIRED',
    );
    const oversized = await fetch(assetUrl, {
      headers: { ...headers, Range: 'bytes=0-5242879' },
    });
    assert.equal(oversized.status, 413);
    assert.equal(
      z.object({ code: z.string() }).parse(await oversized.json()).code,
      'ASSET_RANGE_TOO_LARGE',
    );
    const pieces: Buffer[] = [];
    const chunkSize = 4 * 1024 * 1024;
    for (let start = 0; start < maximum.byteLength; start += chunkSize) {
      const end = Math.min(start + chunkSize, maximum.byteLength) - 1;
      const piece = await fetch(assetUrl, {
        headers: { ...headers, Range: `bytes=${start}-${end}` },
      });
      assert.equal(piece.status, 206);
      assert.equal(
        piece.headers.get('content-range'),
        `bytes ${start}-${end}/${maximum.byteLength}`,
      );
      pieces.push(Buffer.from(await piece.arrayBuffer()));
    }
    assert.deepEqual(Buffer.concat(pieces), maximum);
    const unauthorized = await fetch(`${origin}${request.url}`);
    assert.equal(unauthorized.status, 401);
    await unauthorized.arrayBuffer();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
