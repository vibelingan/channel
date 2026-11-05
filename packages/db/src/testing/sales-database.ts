/** Local transaction substitute, never a production adapter or CloudBase proof. */
import type { NodeSdkDatabase } from '../cloudbase-adapter.ts';
export function createSalesTestDatabase(
  initial: Record<string, Record<string, unknown>> = {},
  persist?: (rows: Record<string, Record<string, unknown>>) => Promise<void>,
) {
  let rows = structuredClone(initial);
  let tail: Promise<unknown> = Promise.resolve();
  let failCollection: string | undefined;
  const db: NodeSdkDatabase = {
    command: { set: (v) => v },
    runTransaction(operation) {
      const run = tail.then(async () => {
        const draft = structuredClone(rows);
        const result = await operation({
          collection: (collection) => ({
            doc: (id) => ({
              async get() {
                return {
                  data: draft[`${collection}/${id}`]
                    ? { ...draft[`${collection}/${id}`], _id: id }
                    : null,
                };
              },
              async set(data) {
                if (failCollection === collection) {
                  failCollection = undefined;
                  throw new Error('Injected write failure');
                }
                draft[`${collection}/${id}`] = structuredClone(data);
                return { updated: 1 };
              },
              async update(data) {
                draft[`${collection}/${id}`] = { ...draft[`${collection}/${id}`], ...data };
                return { updated: 1 };
              },
              async remove() {
                delete draft[`${collection}/${id}`];
                return { deleted: 1 };
              },
            }),
          }),
        });
        if (persist) await persist(draft);
        rows = draft;
        return result;
      });
      tail = run.catch(() => undefined);
      return run;
    },
  };
  return {
    db,
    snapshot: () => structuredClone(rows),
    failNextWrite: (collection: string) => {
      failCollection = collection;
    },
  };
}
