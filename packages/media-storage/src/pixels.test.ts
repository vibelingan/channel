import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import { decodeCatalogImagePixels } from './pixels.ts';

async function sample(format: 'jpeg' | 'png' | 'gif' | 'webp') {
  return sharp({ create: { width: 24, height: 16, channels: 4, background: '#12345680' } })
    .toFormat(format)
    .toBuffer();
}
for (const format of ['jpeg', 'png', 'gif', 'webp'] as const)
  test(`valid ${format} decodes actual pixels and binds the input checksum`, async () => {
    const bytes = await sample(format);
    const result = await decodeCatalogImagePixels(bytes, `image/${format}`);
    assert.deepEqual(result, {
      status: 'decoded',
      kind: 'catalog-image-pixels-v1',
      checksumSha256: createHash('sha256').update(bytes).digest('hex'),
      width: 24,
      height: 16,
      pages: 1,
    });
  });
for (const format of ['jpeg', 'png', 'gif', 'webp'] as const)
  test(`a truncated ${format} cannot pass on its header or a partial image`, async () => {
    const bytes = await sample(format);
    assert.equal(
      (await decodeCatalogImagePixels(bytes.subarray(0, bytes.length - 10), `image/${format}`))
        .status,
      'invalid',
    );
  });
test('a JPEG signature with no pixels is invalid', async () => {
  assert.deepEqual(
    await decodeCatalogImagePixels(Buffer.from([255, 216, 255, 224, 255, 217]), 'image/jpeg'),
    { status: 'invalid', reason: 'content' },
  );
});
test('a valid image cannot be interpreted with another MIME', async () => {
  assert.deepEqual(await decodeCatalogImagePixels(await sample('png'), 'image/jpeg'), {
    status: 'invalid',
    reason: 'content',
  });
});
test('SVG never enters the native decoder', async () => {
  let calls = 0;
  const result = await decodeCatalogImagePixels(
    Buffer.from('<svg onload="alert(1)"/>'),
    'image/svg+xml',
    {
      loadDecoder: async () => {
        calls++;
        return sharp;
      },
    },
  );
  assert.equal(result.status, 'invalid');
  assert.equal(calls, 0);
});
test('empty and oversized inputs do not load the native decoder', async () => {
  let calls = 0;
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(10 * 1024 * 1024 + 1)]) {
    assert.deepEqual(
      await decodeCatalogImagePixels(bytes, 'image/jpeg', {
        loadDecoder: async () => {
          calls++;
          return sharp;
        },
      }),
      { status: 'invalid', reason: 'size' },
    );
  }
  assert.equal(calls, 0);
});
async function animation() {
  const raw = Buffer.alloc(12 * 20 * 4, 255);
  raw.fill(0, 12 * 10 * 4);
  for (let i = 12 * 10 * 4 + 3; i < raw.length; i += 4) raw[i] = 255;
  return sharp(raw, { raw: { width: 12, height: 20, channels: 4, pageHeight: 10 } })
    .gif({ delay: [100, 100] })
    .toBuffer();
}
test('all frames of a valid animation are decoded', async () => {
  const bytes = await animation();
  const result = await decodeCatalogImagePixels(bytes, 'image/gif');
  assert.equal(result.status, 'decoded');
  if (result.status === 'decoded')
    assert.deepEqual([result.width, result.height, result.pages], [12, 10, 2]);
});
test('a GIF with a damaged later frame is rejected even though the first frame renders', async () => {
  const bytes = (await animation()).subarray(0, 75);
  await sharp(bytes).raw().toBuffer();
  assert.deepEqual(await decodeCatalogImagePixels(bytes, 'image/gif'), {
    status: 'invalid',
    reason: 'content',
  });
});
test('a decoder missing at runtime is retryable without exposing paths or exceptions', async () => {
  assert.deepEqual(
    await decodeCatalogImagePixels(await sample('jpeg'), 'image/jpeg', {
      loadDecoder: async () => {
        throw new Error('/private/native/path');
      },
    }),
    { status: 'retry', reason: 'unavailable' },
  );
});
test('the wall deadline includes loading the decoder and discards its late result', async () => {
  const bytes = await sample('png');
  let release: ((decoder: typeof sharp) => void) | undefined;
  const result = await decodeCatalogImagePixels(bytes, 'image/png', {
    timeoutMs: 20,
    loadDecoder: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  assert.deepEqual(result, { status: 'retry', reason: 'timeout' });
  assert.ok(release);
  let nativeCalls = 0;
  const guarded = new Proxy(sharp, {
    apply(target, thisArg, args) {
      nativeCalls++;
      return Reflect.apply(target, thisArg, args);
    },
  });
  release(guarded);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(nativeCalls, 0);
});
test('bytes are frozen before an asynchronous decoder load', async () => {
  const bytes = await sample('png');
  const expected = createHash('sha256').update(bytes).digest('hex');
  const result = await decodeCatalogImagePixels(bytes, 'image/png', {
    loadDecoder: async () => {
      bytes.fill(0);
      return sharp;
    },
  });
  assert.equal(result.status, 'decoded');
  if (result.status === 'decoded') assert.equal(result.checksumSha256, expected);
});

function pngChunk(kind: string, data: Buffer) {
  const tag = Buffer.from(kind);
  const body = Buffer.concat([tag, data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([head, body, tail]);
}
async function apng(damage = false) {
  const png = await sample('png');
  let offset = 8;
  const idats: Buffer[] = [];
  while (offset < png.length) {
    const n = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT')
      idats.push(png.subarray(offset + 8, offset + 8 + n));
    offset += n + 12;
  }
  const count = Buffer.alloc(8);
  count.writeUInt32BE(2);
  const frame = (seq: number) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(seq);
    data.writeUInt32BE(24, 4);
    data.writeUInt32BE(16, 8);
    data.writeUInt16BE(100, 20);
    return pngChunk('fcTL', data);
  };
  const payload = Buffer.concat(idats);
  if (damage) payload.fill(255);
  const sequence = Buffer.alloc(4);
  sequence.writeUInt32BE(2);
  return Buffer.concat([
    png.subarray(0, 33),
    pngChunk('acTL', count),
    frame(0),
    ...idats.map((x) => pngChunk('IDAT', x)),
    frame(1),
    pngChunk('fdAT', Buffer.concat([sequence, payload])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
test('APNG checks both frames while preserving its canvas dimensions', async () => {
  const result = await decodeCatalogImagePixels(await apng(), 'image/png');
  assert.equal(result.status, 'decoded');
  if (result.status === 'decoded')
    assert.deepEqual([result.width, result.height, result.pages], [24, 16, 2]);
});
test('a damaged APNG later frame cannot pass as a still PNG', async () => {
  const bytes = await apng(true);
  await sharp(bytes).raw().toBuffer();
  assert.deepEqual(await decodeCatalogImagePixels(bytes, 'image/png'), {
    status: 'invalid',
    reason: 'content',
  });
});

for (const timeoutMs of [0, -1, 1.5, Number.NaN, 5001])
  test(`invalid pixel deadline never starts a native decoder: ${timeoutMs}`, async () => {
    let calls = 0;
    await assert.rejects(
      decodeCatalogImagePixels(await sample('png'), 'image/png', {
        timeoutMs,
        loadDecoder: async () => {
          calls++;
          return sharp;
        },
      }),
      RangeError,
    );
    assert.equal(calls, 0);
  });
test('PNG CRC corruption is rejected before native processing', async () => {
  const bytes = await sample('png');
  bytes[29] = (bytes[29] ?? 0) ^ 255;
  let calls = 0;
  assert.deepEqual(
    await decodeCatalogImagePixels(bytes, 'image/png', {
      loadDecoder: async () => {
        calls++;
        return sharp;
      },
    }),
    { status: 'invalid', reason: 'content' },
  );
  assert.equal(calls, 0);
});
test('a JPEG with its end marker restored still needs all compressed pixels to decode', async () => {
  const bytes = await sample('jpeg');
  const damaged = Buffer.concat([bytes.subarray(0, bytes.length - 10), Buffer.from([255, 217])]);
  assert.deepEqual(await decodeCatalogImagePixels(damaged, 'image/jpeg'), {
    status: 'invalid',
    reason: 'content',
  });
});
test('long and progressive JPEGs remain supported', async () => {
  const bytes = await sharp({
    create: { width: 1200, height: 2847, channels: 3, background: '#123456' },
  })
    .jpeg({ progressive: true })
    .toBuffer();
  const result = await decodeCatalogImagePixels(bytes, 'image/jpeg');
  assert.equal(result.status, 'decoded');
  if (result.status === 'decoded') assert.deepEqual([result.width, result.height], [1200, 2847]);
});
test('indexed transparent PNG images remain supported', async () => {
  const bytes = await sharp({
    create: { width: 24, height: 16, channels: 4, background: '#12345680' },
  })
    .png({ palette: true })
    .toBuffer();
  assert.equal((await decodeCatalogImagePixels(bytes, 'image/png')).status, 'decoded');
});
test('truncated containers at every byte offset return controlled results', async () => {
  for (const format of ['jpeg', 'png', 'gif', 'webp'] as const) {
    const bytes = await sample(format);
    for (let offset = 0; offset < bytes.length; offset++) {
      const result = await decodeCatalogImagePixels(bytes.subarray(0, offset), `image/${format}`);
      assert.notEqual(result.status, 'decoded', `${format}/${offset}`);
    }
  }
});

test('a consumed deadline cannot start native work after synchronous container checks', async () => {
  const bytes = await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: '#12345680' },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  let calls = 0;
  assert.deepEqual(
    await decodeCatalogImagePixels(bytes, 'image/png', {
      timeoutMs: 1,
      loadDecoder: async () => {
        calls++;
        return sharp;
      },
    }),
    { status: 'retry', reason: 'timeout' },
  );
  assert.equal(calls, 0);
});

function pngParts(bytes: Buffer) {
  const chunks: { kind: string; data: Buffer }[] = [];
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const size = bytes.readUInt32BE(offset);
    chunks.push({
      kind: bytes.toString('ascii', offset + 4, offset + 8),
      data: Buffer.from(bytes.subarray(offset + 8, offset + 8 + size)),
    });
    offset += size + 12;
  }
  return chunks;
}
function packPng(parts: ReturnType<typeof pngParts>) {
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    ...parts.map((part) => pngChunk(part.kind, part.data)),
  ]);
}
for (const field of ['sequence', 'count'] as const)
  test(`invalid APNG ${field} cannot be certified by its working poster`, async () => {
    const parts = pngParts(await apng());
    const target = parts.find((part) => part.kind === (field === 'sequence' ? 'fdAT' : 'acTL'));
    assert.ok(target);
    target.data.writeUInt32BE(9, 0);
    const bytes = packPng(parts);
    await sharp(bytes).raw().toBuffer();
    assert.deepEqual(await decodeCatalogImagePixels(bytes, 'image/png'), {
      status: 'invalid',
      reason: 'content',
    });
  });
test('an APNG with a separate poster and a smaller frame remains supported', async () => {
  const original = pngParts(await apng());
  const header = original.find((part) => part.kind === 'IHDR');
  const actl = original.find((part) => part.kind === 'acTL');
  const idats = original.filter((part) => part.kind === 'IDAT');
  assert.ok(header && actl);
  const first = Buffer.alloc(26);
  first.writeUInt32BE(12, 4);
  first.writeUInt32BE(8, 8);
  first.writeUInt32BE(5, 12);
  first.writeUInt32BE(5, 16);
  const crop = await sharp({
    create: { width: 12, height: 8, channels: 4, background: '#12345680' },
  })
    .png()
    .toBuffer();
  const cropData = Buffer.concat(
    pngParts(crop)
      .filter((part) => part.kind === 'IDAT')
      .map((part) => part.data),
  );
  const seq1 = Buffer.alloc(4);
  seq1.writeUInt32BE(1);
  const second = Buffer.from(first);
  second.writeUInt32BE(2);
  second.writeUInt32BE(24, 4);
  second.writeUInt32BE(16, 8);
  second.writeUInt32BE(0, 12);
  second.writeUInt32BE(0, 16);
  const seq3 = Buffer.alloc(4);
  seq3.writeUInt32BE(3);
  const bytes = packPng([
    header,
    actl,
    ...idats,
    { kind: 'fcTL', data: first },
    { kind: 'fdAT', data: Buffer.concat([seq1, cropData]) },
    { kind: 'fcTL', data: second },
    { kind: 'fdAT', data: Buffer.concat([seq3, ...idats.map((part) => part.data)]) },
    { kind: 'IEND', data: Buffer.alloc(0) },
  ]);
  const result = await decodeCatalogImagePixels(bytes, 'image/png');
  assert.equal(result.status, 'decoded');
  if (result.status === 'decoded')
    assert.deepEqual([result.width, result.height, result.pages], [24, 16, 2]);
});
test('palette and transparency remain available to every APNG frame', async () => {
  const png = await sharp({
    create: { width: 24, height: 16, channels: 4, background: '#12345680' },
  })
    .png({ palette: true })
    .toBuffer();
  const base = pngParts(await apng());
  const firstIdat = base.findIndex((part) => part.kind === 'IDAT');
  const replacement = pngParts(png);
  const header = replacement.find((part) => part.kind === 'IHDR');
  const idat = Buffer.concat(
    replacement.filter((part) => part.kind === 'IDAT').map((part) => part.data),
  );
  assert.ok(header);
  base[0] = header;
  base.splice(firstIdat, 1, { kind: 'IDAT', data: idat });
  const fdat = base.find((part) => part.kind === 'fdAT');
  assert.ok(fdat);
  fdat.data = Buffer.concat([fdat.data.subarray(0, 4), idat]);
  base.splice(1, 0, ...replacement.filter((part) => ['PLTE', 'tRNS'].includes(part.kind)));
  assert.equal((await decodeCatalogImagePixels(packPng(base), 'image/png')).status, 'decoded');
});

test('zero-length IDAT and fdAT payload chunks remain valid when followed by frame data', async () => {
  const parts = pngParts(await apng());
  const idat = parts.findIndex((part) => part.kind === 'IDAT');
  parts.splice(idat, 0, { kind: 'IDAT', data: Buffer.alloc(0) });
  const fdat = parts.findIndex((part) => part.kind === 'fdAT');
  const original = parts[fdat];
  assert.ok(original);
  const empty = Buffer.alloc(4);
  empty.writeUInt32BE(2);
  original.data.writeUInt32BE(3);
  parts.splice(fdat, 0, { kind: 'fdAT', data: empty });
  const bytes = packPng(parts);
  await sharp(bytes).raw().toBuffer();
  const result = await decodeCatalogImagePixels(bytes, 'image/png');
  assert.equal(result.status, 'decoded');
  if (result.status === 'decoded') assert.equal(result.pages, 2);
});
test('an entire animation frame without pixel data remains invalid', async () => {
  const parts = pngParts(await apng());
  const target = parts.find((part) => part.kind === 'fdAT');
  assert.ok(target);
  target.data = target.data.subarray(0, 4);
  assert.deepEqual(await decodeCatalogImagePixels(packPng(parts), 'image/png'), {
    status: 'invalid',
    reason: 'content',
  });
});
test('fdAT shorter than its sequence field is invalid without a range exception', async () => {
  const parts = pngParts(await apng());
  const target = parts.find((part) => part.kind === 'fdAT');
  assert.ok(target);
  target.data = Buffer.alloc(3);
  assert.deepEqual(await decodeCatalogImagePixels(packPng(parts), 'image/png'), {
    status: 'invalid',
    reason: 'content',
  });
});
