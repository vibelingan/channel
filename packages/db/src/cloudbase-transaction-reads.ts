/** One queue per native transaction; independent transactions keep their concurrency. */
export function serializeCloudBaseTransactionReads<T>(
  read: (collection: string, id: string) => Promise<T>,
): (collection: string, id: string) => Promise<T> {
  let previous: Promise<void> = Promise.resolve();
  return (collection, id) => {
    const result = previous.then(() => read(collection, id));
    previous = result.then(() => undefined);
    // Keep the rejected chain so queued reads cannot run in an aborted transaction.
    // The caller still receives the original rejection through result.
    void previous.catch(() => undefined);
    return result;
  };
}
