/** Per-detail speculative queue. URL is resource identity; never stores product data. */
export function createImagePrefetchQueue(load: (source: string) => Promise<void>, concurrency = 2) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error('Invalid image queue concurrency');
  const pending: string[] = [];
  const seen = new Set<string>();
  let running = 0;
  let stopped = false;
  const pump = () => {
    while (!stopped && running < concurrency && pending.length) {
      const source = pending.shift();
      if (!source) continue;
      running++;
      void Promise.resolve()
        .then(() => load(source))
        .catch(() => {
          // Speculation may fail; the actual <img> retains its normal error/retry path.
        })
        .finally(() => {
          running--;
          pump();
        });
    }
  };
  return {
    enqueue(sources: readonly string[]) {
      if (stopped) return;
      for (const source of sources)
        if (!seen.has(source)) {
          seen.add(source);
          pending.push(source);
        }
      pump();
    },
    stop() {
      stopped = true;
      pending.length = 0;
    },
  };
}
