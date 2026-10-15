type Frame = { width: number; height: number; data: Buffer[] };
export type PngAnimation = { pages: number; frames: Iterable<Buffer> };
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 255] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(kind: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(kind), data]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, tail]);
}

/** Exposes every APNG frame to a PNG decoder that otherwise reads only its still image. */
export function readPngAnimation(bytes: Buffer): PngAnimation | null | undefined {
  let offset = 8;
  let count: number | undefined;
  let sequence = 0;
  let firstData = false;
  let ended = false;
  let current: Frame | undefined;
  const frames: Frame[] = [];
  const fallback: Buffer[] = [];
  const globals: Buffer[] = [];
  const header = bytes.subarray(16, 29);
  if (header.length !== 13) return null;
  const canvasWidth = header.readUInt32BE(0);
  const canvasHeight = header.readUInt32BE(4);
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return null;
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (
      crc32(bytes.subarray(offset + 4, offset + 8 + length)) !==
      bytes.readUInt32BE(offset + 8 + length)
    )
      return null;
    if (kind === 'acTL') {
      if (count !== undefined || firstData || length !== 8) return null;
      count = data.readUInt32BE(0);
      if (!count) return null;
    } else if (kind === 'fcTL') {
      if (count === undefined || length !== 26 || data.readUInt32BE(0) !== sequence++) return null;
      if (current && !current.data.length) return null;
      const width = data.readUInt32BE(4);
      const height = data.readUInt32BE(8);
      if (
        !width ||
        !height ||
        data.readUInt32BE(12) > canvasWidth - width ||
        data.readUInt32BE(16) > canvasHeight - height ||
        data.readUInt8(24) > 2 ||
        data.readUInt8(25) > 1
      )
        return null;
      if (
        !firstData &&
        (width !== canvasWidth ||
          height !== canvasHeight ||
          data.readUInt32BE(12) !== 0 ||
          data.readUInt32BE(16) !== 0)
      )
        return null;
      current = { width, height, data: [] };
      frames.push(current);
    } else if (kind === 'fdAT') {
      if (!firstData || !current || length < 5 || data.readUInt32BE(0) !== sequence++) return null;
      current.data.push(data.subarray(4));
    } else if (kind === 'IDAT') {
      if (frames.length > 1) return null;
      firstData = true;
      if (current) current.data.push(data);
      else fallback.push(data);
    } else if (kind === 'IEND') {
      if (length !== 0) return null;
      ended = true;
      break;
    } else if (!firstData && ['PLTE', 'tRNS'].includes(kind))
      globals.push(bytes.subarray(offset, offset + length + 12));
    offset += length + 12;
  }
  if (!ended) return null;
  if (count === undefined) return frames.length ? null : undefined;
  if (frames.length !== count || !current?.data.length) return null;
  const allFrames = fallback.length
    ? [{ width: canvasWidth, height: canvasHeight, data: fallback }, ...frames]
    : frames;
  if (allFrames.reduce((total, frame) => total + frame.width * frame.height, 0) > 268402689)
    return null;
  return {
    pages: count,
    frames: {
      *[Symbol.iterator]() {
        for (const frame of allFrames) {
          const ihdr = Buffer.from(header);
          ihdr.writeUInt32BE(frame.width, 0);
          ihdr.writeUInt32BE(frame.height, 4);
          yield Buffer.concat([
            signature,
            chunk('IHDR', ihdr),
            ...globals,
            ...frame.data.map((data) => chunk('IDAT', data)),
            chunk('IEND', Buffer.alloc(0)),
          ]);
        }
      },
    },
  };
}
