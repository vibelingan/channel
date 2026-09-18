import { Buffer } from 'node:buffer';
import {
  CatalogTaxonomyCommandSchema,
  type CatalogTaxonomyResult,
  CatalogTaxonomySchema,
  initialCatalogTaxonomy,
} from '@vibelingan-channel/shared';
import { z } from 'zod';
import type { CategoryTransaction } from './category-transaction.ts';

const timestamp = z.string().datetime({ offset: true });
const maxRequestBytes = 16 * 1024;

export async function runCatalogTaxonomyCommand(
  tx: CategoryTransaction,
  actorId: string,
  input: unknown,
  now: string,
): Promise<CatalogTaxonomyResult> {
  try {
    const serialized = JSON.stringify(input);
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maxRequestBytes)
      return { kind: 'taxonomy', status: 'invalid' };
  } catch {
    return { kind: 'taxonomy', status: 'invalid' };
  }
  const parsed = CatalogTaxonomyCommandSchema.safeParse(input);
  if (!parsed.success || !timestamp.safeParse(now).success)
    return { kind: 'taxonomy', status: 'invalid' };
  const actor = await tx.get('users', actorId);
  if (!actor || actor.role !== 'admin' || actor.status === 'suspended')
    return { kind: 'taxonomy', status: 'forbidden' };
  const command = parsed.data;
  const stored = await tx.get('catalogTaxonomies', command.family);
  const current = CatalogTaxonomySchema.safeParse(
    stored
      ? {
          family: stored.family,
          revision: stored.revision,
          name: stored.name,
          children: stored.children,
        }
      : initialCatalogTaxonomy(command.family),
  );
  if (
    !current.success ||
    current.data.family !== command.family ||
    (stored && stored._id !== command.family)
  )
    return { kind: 'taxonomy', status: 'invalid' };
  if (command.operation === 'read')
    return { kind: 'taxonomy', status: 'replayed', registry: current.data };
  if (command.expectedRevision !== current.data.revision)
    return { kind: 'taxonomy', status: 'conflict' };
  const candidate = CatalogTaxonomySchema.safeParse({
    family: current.data.family,
    revision: current.data.revision + 1,
    name: command.name,
    children: command.children,
  });
  if (
    !candidate.success ||
    current.data.children.some(
      (existing) =>
        !candidate.data.children.some(
          (child) => child.id === existing.id && child.slug === existing.slug,
        ),
    )
  )
    return { kind: 'taxonomy', status: 'invalid' };
  await tx.set('catalogTaxonomies', {
    ...stored,
    ...candidate.data,
    _id: command.family,
    updatedAt: now,
  });
  return {
    kind: 'taxonomy',
    status: stored ? 'applied' : 'configured',
    registry: candidate.data,
  };
}
