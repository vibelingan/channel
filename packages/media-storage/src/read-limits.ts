import { type MediaObjectReadOptions, MediaReadError, isMediaReadError } from './index.ts';

/** Includes source setup and the full body. Late results cannot extend the deadline. */
export async function readMediaBytes(
  start: (signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>,
  options: MediaObjectReadOptions,
): Promise<Buffer> {
  const { maxBytes, timeoutMs } = options;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2147483647
  )
    throw new RangeError('Invalid media read limits');
  const controller = new AbortController();
  let iterator: AsyncIterator<Uint8Array> | undefined;
  let closed = false;
  const close = () => {
    if (!iterator || closed) return;
    closed = true;
    try {
      void Promise.resolve(iterator.return?.()).catch(() => {});
    } catch {}
  };
  const consume = async () => {
    const stream = await start(controller.signal);
    iterator = stream[Symbol.asyncIterator]();
    if (controller.signal.aborted) {
      close();
      throw new MediaReadError('timeout');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = await iterator.next();
      if (controller.signal.aborted) throw new MediaReadError('timeout');
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new MediaReadError('unavailable');
      if (chunk.value.byteLength > maxBytes - total) throw new MediaReadError('too-large');
      total += chunk.value.byteLength;
      // Copy only the admitted chunk, without retaining an oversized backing buffer.
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks, total);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new MediaReadError('timeout'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([consume(), deadline]);
  } catch (error) {
    if (controller.signal.aborted) throw new MediaReadError('timeout');
    if (isMediaReadError(error)) throw error;
    throw new MediaReadError('unavailable');
  } finally {
    clearTimeout(timer);
    controller.abort();
    // An uncooperative source must not hold the caller while closing.
    close();
  }
}
