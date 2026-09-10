import assert from 'node:assert/strict';
import test from 'node:test';
import { createImagePrefetchQueue } from './catalog-image-prefetch.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
test('image queue deduplicates queued/in-flight/completed URLs and limits concurrency', async () => {
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  const queue = createImagePrefetchQueue((source) => {
    started.push(source);
    return new Promise<void>((resolve) => finish.set(source, resolve));
  });
  queue.enqueue(['black', 'white', 'pink', 'white']);
  await tick();
  assert.deepEqual(started, ['black', 'white']);
  queue.enqueue(['black', 'pink']);
  finish.get('black')?.();
  await tick();
  assert.deepEqual(started, ['black', 'white', 'pink']);
  finish.get('white')?.();
  finish.get('pink')?.();
  await tick();
  queue.enqueue(['black', 'white', 'pink']);
  await tick();
  assert.equal(started.length, 3);
});
test('failed speculation drains the queue; navigation stops only queued work', async () => {
  const started: string[] = [];
  let finish: (() => void) | undefined;
  const queue = createImagePrefetchQueue(async (source) => {
    started.push(source);
    if (source === 'broken') throw new Error('network');
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  }, 1);
  queue.enqueue(['broken', 'white', 'pink']);
  await tick();
  assert.deepEqual(started, ['broken', 'white']);
  queue.stop();
  finish?.();
  queue.enqueue(['new']);
  await tick();
  assert.deepEqual(started, ['broken', 'white']);
});
test('invalid concurrency cannot silently stall a queue', () => {
  for (const n of [0, -1, 1.5, Number.POSITIVE_INFINITY])
    assert.throws(() => createImagePrefetchQueue(async () => {}, n));
});
