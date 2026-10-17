import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const record = z
  .object({ schemaVersion: z.literal('catalog-preparation-task-v1'), productId: id, jobId: hex })
  .strict();
type TaskStorage = Pick<Storage, 'getItem' | 'setItem'>;
function key(actorId: string, productId: string): string | null {
  return id.safeParse(actorId).success && id.safeParse(productId).success
    ? `channel.catalog-preparation.v1:${JSON.stringify([actorId, productId])}`
    : null;
}
/** Storage is only a task locator. The server always checks current input and permissions. */
export function readPreparationTask(
  storage: TaskStorage,
  actorId: string,
  productId: string,
): string | null {
  const name = key(actorId, productId);
  if (name === null) return null;
  try {
    const raw = storage.getItem(name);
    if (typeof raw !== 'string' || raw.length > 1024) return null;
    const parsed = record.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.productId === productId ? parsed.data.jobId : null;
  } catch {
    return null;
  }
}
export function savePreparationTask(
  storage: TaskStorage,
  actorId: string,
  productId: string,
  jobId: string,
): boolean {
  const name = key(actorId, productId);
  const checked = record.safeParse({
    schemaVersion: 'catalog-preparation-task-v1',
    productId,
    jobId,
  });
  if (name === null || !checked.success) return false;
  try {
    storage.setItem(name, JSON.stringify(checked.data));
    return true;
  } catch {
    return false;
  }
}
