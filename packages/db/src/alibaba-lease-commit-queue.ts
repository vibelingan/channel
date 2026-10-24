import type { AlibabaLeaseGuard } from './adapter.ts';

const commits = new Map<string, Promise<void>>();

/** Avoid self-contention on the lease write; the transaction still enforces ownership. */
export async function withAlibabaLeaseCommit<Result>(
  guard: Pick<AlibabaLeaseGuard, 'connectionId' | 'holder' | 'fence'>,
  operation: () => Promise<Result>,
): Promise<Result> {
  const key = JSON.stringify([guard.connectionId, guard.holder, guard.fence]);
  const previous = commits.get(key) ?? Promise.resolve();
  let release = () => {};
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => finished);
  commits.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (commits.get(key) === tail) commits.delete(key);
  }
}
