import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaReadError } from './index.ts';
import { readMediaBytes } from './read-limits.ts';
const options = { maxBytes: 5, timeoutMs: 1000 };
test('bounded reading returns the exact byte sequence', async () => {
  const result = await readMediaBytes(
    async () =>
      (async function* () {
        yield Buffer.from([1, 2]);
        yield Buffer.from([3, 4, 5]);
      })(),
    options,
  );
  assert.deepEqual(result, Buffer.from([1, 2, 3, 4, 5]));
});
test('one extra byte stops consumption and closes the source', async () => {
  let pulled = 0;
  let closed = false;
  await assert.rejects(
    readMediaBytes(
      async () =>
        (async function* () {
          try {
            pulled++;
            yield Buffer.alloc(4);
            pulled++;
            yield Buffer.alloc(2);
            pulled++;
            yield Buffer.alloc(1);
          } finally {
            closed = true;
          }
        })(),
      options,
    ),
    (error) => error instanceof MediaReadError && error.reason === 'too-large',
  );
  assert.equal(pulled, 2);
  assert.equal(closed, true);
});
test('a cap-sized read does not depend on declared metadata', async () => {
  assert.equal(
    (
      await readMediaBytes(
        async () =>
          (async function* () {
            yield Buffer.alloc(5);
          })(),
        options,
      )
    ).length,
    5,
  );
});
test('an oversized first chunk is rejected without a second read', async () => {
  let pulled = 0;
  await assert.rejects(
    readMediaBytes(
      async () =>
        (async function* () {
          pulled++;
          yield Buffer.alloc(6);
          pulled++;
          yield Buffer.alloc(1);
        })(),
      options,
    ),
    (error) => error instanceof MediaReadError && error.reason === 'too-large',
  );
  assert.equal(pulled, 1);
});
test('the total deadline covers a stalled start and aborts its signal', async () => {
  let signal: AbortSignal | undefined;
  const started = Date.now();
  await assert.rejects(
    readMediaBytes(
      async (value) => {
        signal = value;
        return new Promise(() => {});
      },
      { ...options, timeoutMs: 30 },
    ),
    (error) => error instanceof MediaReadError && error.reason === 'timeout',
  );
  assert.ok(signal?.aborted);
  assert.ok(Date.now() - started < 500);
});
test('a stalled body cannot extend the total deadline', async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(
    readMediaBytes(
      async (value) => {
        signal = value;
        return (async function* () {
          yield Buffer.alloc(1);
          await new Promise(() => {});
          yield Buffer.alloc(1);
        })();
      },
      { ...options, timeoutMs: 30 },
    ),
    (error) => error instanceof MediaReadError && error.reason === 'timeout',
  );
  assert.ok(signal?.aborted);
});
test('a source whose cleanup never completes cannot hold a timeout response', async () => {
  let closed = 0;
  const stream: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise(() => {}),
        return: () => {
          closed++;
          return new Promise(() => {});
        },
      };
    },
  };
  await assert.rejects(
    readMediaBytes(async () => stream, { ...options, timeoutMs: 30 }),
    (error) => error instanceof MediaReadError && error.reason === 'timeout',
  );
  assert.equal(closed, 1);
});
test('a late start must not consume a source after the deadline', async () => {
  let resolveStart: ((value: AsyncIterable<Uint8Array>) => void) | undefined;
  let pulled = 0;
  let closed = 0;
  const stream: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          pulled++;
          return { done: true, value: undefined };
        },
        return: async () => {
          closed++;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const reading = readMediaBytes(
    () =>
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    { ...options, timeoutMs: 30 },
  );
  await assert.rejects(
    reading,
    (error) => error instanceof MediaReadError && error.reason === 'timeout',
  );
  assert.ok(resolveStart);
  resolveStart(stream);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(pulled, 0);
  assert.equal(closed, 1);
});
test('source failures are redacted', async () => {
  await assert.rejects(
    readMediaBytes(async () => {
      throw new Error('https://private.example/?secret=token');
    }, options),
    (error) =>
      error instanceof MediaReadError &&
      error.reason === 'unavailable' &&
      !String(error).includes('private.example'),
  );
});
test('empty objects return zero actual bytes for caller validation', async () => {
  assert.equal((await readMediaBytes(async () => (async function* () {})(), options)).length, 0);
});
for (const change of [
  { maxBytes: 0 },
  { maxBytes: -1 },
  { maxBytes: Number.POSITIVE_INFINITY },
  { maxBytes: 1.5 },
  { timeoutMs: 0 },
  { timeoutMs: -1 },
  { timeoutMs: Number.POSITIVE_INFINITY },
  { timeoutMs: 1.5 },
  { timeoutMs: 2147483648 },
])
  test(`invalid read limits do not start work: ${JSON.stringify(change)}`, async () => {
    let calls = 0;
    await assert.rejects(
      readMediaBytes(
        async () => {
          calls++;
          return (async function* () {})();
        },
        { ...options, ...change },
      ),
    );
    assert.equal(calls, 0);
  });

test('late body results cannot pull more bytes after the caller timed out', async () => {
  let reads = 0;
  let release: ((value: IteratorResult<Uint8Array>) => void) | undefined;
  const stream: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          reads++;
          return reads === 1
            ? new Promise((resolve) => {
                release = resolve;
              })
            : Promise.resolve({ done: true, value: undefined });
        },
        return: async () => ({ done: true, value: undefined }),
      };
    },
  };
  await assert.rejects(
    readMediaBytes(async () => stream, { ...options, timeoutMs: 30 }),
    (error) => error instanceof MediaReadError && error.reason === 'timeout',
  );
  assert.ok(release);
  release({ done: false, value: Buffer.alloc(1) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reads, 1);
});
test('a rejecting cleanup cannot become an unhandled failure after a completed read', async () => {
  let reads = 0;
  const stream: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () =>
          ++reads === 1
            ? { done: false, value: Buffer.alloc(5) }
            : { done: true, value: undefined },
        return: async () => {
          throw new Error('cleanup failure');
        },
      };
    },
  };
  assert.equal((await readMediaBytes(async () => stream, options)).length, 5);
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('read limits are captured before the source can change its options', async () => {
  const limits = { ...options };
  await assert.rejects(
    readMediaBytes(
      async () =>
        (async function* () {
          yield Buffer.alloc(2);
          limits.maxBytes = 100;
          yield Buffer.alloc(4);
        })(),
      limits,
    ),
    (error) => error instanceof MediaReadError && error.reason === 'too-large',
  );
});
test('borrowed chunk memory cannot change bytes that were already read', async () => {
  const borrowed = Buffer.from([1, 2, 3]);
  const result = await readMediaBytes(
    async () =>
      (async function* () {
        yield borrowed;
        borrowed[0] = 99;
        yield Buffer.from([4, 5]);
      })(),
    options,
  );
  assert.deepEqual(result, Buffer.from([1, 2, 3, 4, 5]));
});
test('string chunks cannot be converted into apparently valid byte evidence', async () => {
  const chunk = { done: false as const, value: new Uint8Array(1) };
  Reflect.set(chunk, 'value', 'untrusted text');
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return { next: async () => chunk };
    },
  };
  await assert.rejects(
    readMediaBytes(async () => source, options),
    (error) => error instanceof MediaReadError && error.reason === 'unavailable',
  );
});
