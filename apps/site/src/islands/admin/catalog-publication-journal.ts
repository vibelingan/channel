import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import { z } from 'zod';
import { AdminApiError } from './api.ts';
import { PublicationCheckpointSchema } from './catalog-product-operation-api.ts';
export type { PublicationCheckpoint } from './catalog-product-operation-api.ts';

const VERSION = 'catalog-publication-recovery-v1';
const MAX_ENTRIES = 500;
const MAX_KEYS = 2000;
const MAX_EXPORT_BYTES = 1024 * 1024;
const OwnerSchema = z
  .object({
    actorId: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.trim() === value),
    endpoint: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ['http:', 'https:'].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
          );
        } catch {
          return false;
        }
      }),
  })
  .strict();
const EntrySchema = PublicationCheckpointSchema;
const RecordSchema = z
  .object({ schemaVersion: z.literal(VERSION), owner: OwnerSchema, entry: EntrySchema })
  .strict();
const ExportSchema = z
  .object({
    schemaVersion: z.literal(VERSION),
    owner: OwnerSchema,
    entries: z.array(EntrySchema).max(MAX_ENTRIES),
  })
  .strict();
import type { PublicationCheckpoint } from './catalog-product-operation-api.ts';
type Problem = 'unavailable' | 'corrupt' | 'limit';
export type PublicationJournalSnapshot = {
  entries: PublicationCheckpoint[];
  durability: 'persistent' | 'memory';
  problems: Problem[];
};
export type PublicationJournalStorage = Pick<
  Storage,
  'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'
>;
class JournalError extends AdminApiError {}
const invalid = () =>
  new JournalError('VALIDATION_ERROR', 'Check the publication recovery record.');
function checkpoint(value: unknown) {
  if (!fitsJsonBudget(value, 4096, 12)) throw invalid();
  const parsed = EntrySchema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}
function compatible(previous: PublicationCheckpoint | undefined, next: PublicationCheckpoint) {
  if (
    previous?.scope.inputDigest &&
    next.scope.inputDigest &&
    previous.scope.inputDigest !== next.scope.inputDigest
  )
    throw new JournalError(
      'CONFLICT',
      'This publication already has a different saved input. Check the original task.',
    );
}

/** Local pointers are fallible recovery aids; only the server decides their current state. */
export function createPublicationJournal(
  input: unknown,
  storage: () => PublicationJournalStorage = () => globalThis.localStorage,
) {
  const parsedOwner = OwnerSchema.safeParse(input);
  if (!parsedOwner.success) throw invalid();
  const owner = parsedOwner.data;
  const prefix = `channel:publication:v1:${JSON.stringify([owner.actorId, owner.endpoint])}:`;
  const key = (entry: PublicationCheckpoint) =>
    prefix + JSON.stringify([entry.scope.productId, entry.scope.operationId]);
  let memory = new Map<string, PublicationCheckpoint>();
  const pending = new Set<string>();
  const readRecord = (bytes: string, expectedKey: string) => {
    if (bytes.length > 4096) throw invalid();
    const value: unknown = JSON.parse(bytes);
    if (!fitsJsonBudget(value, 4096, 16)) throw invalid();
    const parsed = RecordSchema.safeParse(value);
    if (
      !parsed.success ||
      JSON.stringify(parsed.data.owner) !== JSON.stringify(owner) ||
      key(parsed.data.entry) !== expectedKey
    )
      throw invalid();
    return parsed.data.entry;
  };
  const read = (): PublicationJournalSnapshot => {
    const records = new Map<string, PublicationCheckpoint>();
    const problems = new Set<Problem>();
    let accessible = true;
    try {
      const disk = storage();
      const length = disk.length;
      if (!Number.isSafeInteger(length) || length < 0) throw invalid();
      if (length > MAX_KEYS) problems.add('limit');
      for (let index = 0; index < Math.min(length, MAX_KEYS); index++) {
        const name = disk.key(index);
        if (!name?.startsWith(prefix)) continue;
        if (records.size >= MAX_ENTRIES) {
          problems.add('limit');
          break;
        }
        const bytes = disk.getItem(name);
        if (bytes === null) continue;
        try {
          records.set(name, readRecord(bytes, name));
        } catch {
          problems.add('corrupt');
        }
      }
    } catch {
      accessible = false;
      problems.add('unavailable');
    }
    if (!accessible || problems.has('limit'))
      for (const [name, entry] of memory) if (!records.has(name)) records.set(name, entry);
    for (const name of pending) {
      const entry = memory.get(name);
      if (entry) records.set(name, entry);
    }
    memory = records;
    if (pending.size > 0) problems.add('unavailable');
    return {
      entries: structuredClone([...records.values()]),
      durability: accessible && pending.size === 0 && problems.size === 0 ? 'persistent' : 'memory',
      problems: [...problems],
    };
  };
  const retain = (value: unknown): PublicationJournalSnapshot => {
    const entry = checkpoint(value);
    const name = key(entry);
    // Continuing a known task needs only its own key; listing belongs to read().
    const before: { problems: Problem[] } = memory.has(name) ? { problems: [] } : read();
    const previous = memory.get(name);
    const wasPending = pending.has(name);
    compatible(previous, entry);
    if (!previous && (memory.size >= MAX_ENTRIES || before.problems.includes('limit')))
      throw new JournalError(
        'RECOVERY_STORAGE_FULL',
        'Keep the recovery export and close resolved tasks before starting another publication.',
      );
    if (!entry.scope.inputDigest && previous?.scope.inputDigest)
      entry.scope.inputDigest = previous.scope.inputDigest;
    const bytes = JSON.stringify({ schemaVersion: VERSION, owner, entry });
    if (!fitsJsonBudget(JSON.parse(bytes), 4096, 16)) throw invalid();
    // Keep the pointer even if acquiring or writing storage throws.
    memory.set(name, entry);
    pending.add(name);
    try {
      const disk = storage();
      const existing = disk.getItem(name);
      if (existing !== null) {
        let saved: PublicationCheckpoint;
        try {
          saved = readRecord(existing, name);
        } catch {
          throw new JournalError(
            'RECOVERY_CORRUPT',
            'Keep the recovery export and check the original publication record.',
          );
        }
        compatible(saved, entry);
        if (!entry.scope.inputDigest && saved.scope.inputDigest)
          entry.scope.inputDigest = saved.scope.inputDigest;
      }
      const captured = JSON.stringify({ schemaVersion: VERSION, owner, entry });
      disk.setItem(name, captured);
      if (disk.getItem(name) !== captured) throw Error('Recovery storage write not confirmed');
      pending.delete(name);
    } catch (error) {
      if (error instanceof JournalError) {
        memory.delete(name);
        pending.delete(name);
        if (previous) memory.set(name, previous);
        if (wasPending) pending.add(name);
        throw error;
      }
    }
    const problems = new Set<Problem>(before.problems);
    if (pending.size > 0) problems.add('unavailable');
    return {
      entries: structuredClone([...memory.values()]),
      durability: problems.size === 0 ? 'persistent' : 'memory',
      problems: [...problems],
    } satisfies PublicationJournalSnapshot;
  };
  const forget = (scope: unknown): PublicationJournalSnapshot => {
    const entry = checkpoint({ scope });
    const name = key(entry);
    read();
    try {
      const disk = storage();
      disk.removeItem(name);
      if (disk.getItem(name) !== null) throw Error('Recovery removal not confirmed');
      pending.delete(name);
      memory.delete(name);
    } catch {
      if (memory.has(name)) pending.add(name);
    }
    return read();
  };
  const exportRecords = (selectedScope?: unknown) => {
    const snapshot = read();
    let entries = snapshot.entries;
    if (selectedScope !== undefined) {
      const selected = checkpoint({ scope: selectedScope });
      const name = key(selected);
      let entry = memory.get(name);
      if (!entry) {
        try {
          const bytes = storage().getItem(name);
          if (bytes !== null) entry = readRecord(bytes, name);
        } catch {
          throw invalid();
        }
      }
      if (!entry) throw invalid();
      compatible(entry, selected);
      entries = [entry];
    } else if (snapshot.problems.includes('limit') || entries.length > MAX_ENTRIES) {
      throw new JournalError(
        'RECOVERY_STORAGE_FULL',
        'Export a selected publication or close resolved tasks before exporting the full record.',
      );
    }
    const value = { schemaVersion: VERSION, owner, entries };
    if (!fitsJsonBudget(value, MAX_EXPORT_BYTES, 20)) throw invalid();
    return JSON.stringify(value);
  };
  const importRecords = (bytes: string) => {
    if (typeof bytes !== 'string' || bytes.length > MAX_EXPORT_BYTES) throw invalid();
    let value: unknown;
    try {
      value = JSON.parse(bytes);
    } catch {
      throw invalid();
    }
    if (!fitsJsonBudget(value, MAX_EXPORT_BYTES, 20)) throw invalid();
    const parsed = ExportSchema.safeParse(value);
    if (!parsed.success || JSON.stringify(parsed.data.owner) !== JSON.stringify(owner))
      throw invalid();
    const entries = parsed.data.entries.map(checkpoint);
    const names = new Set(entries.map(key));
    if (names.size !== entries.length) throw invalid();
    const current = read();
    if (
      current.problems.includes('limit') ||
      new Set([...memory.keys(), ...names]).size > MAX_ENTRIES
    )
      throw invalid();
    for (const entry of entries) compatible(memory.get(key(entry)), entry);
    // Check every existing target before the first import write. Storage is not a CAS lock.
    try {
      const disk = storage();
      for (const entry of entries) {
        const existing = disk.getItem(key(entry));
        if (existing === null) continue;
        let saved: PublicationCheckpoint;
        try {
          saved = readRecord(existing, key(entry));
        } catch {
          throw new JournalError(
            'RECOVERY_CORRUPT',
            'Check the saved recovery record before importing.',
          );
        }
        compatible(saved, entry);
      }
    } catch (error) {
      if (error instanceof JournalError) throw error;
    }
    for (const entry of entries) retain(entry);
    return read();
  };
  return { retain, read, forget, export: exportRecords, import: importRecords };
}
