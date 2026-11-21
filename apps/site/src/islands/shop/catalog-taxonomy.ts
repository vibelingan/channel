import type { ProductFamily } from '@vibelingan-channel/shared/catalog-product';
import {
  CatalogTaxonomySchema,
  MAX_TAXONOMY_CHILDREN,
} from '@vibelingan-channel/shared/catalog-taxonomy';
import { z } from 'zod';
import { readApiEnvelope } from '../../lib/api-envelope.ts';
import { apiUrl } from '../../lib/api-url.ts';
import { type NumberedCatalogQuery, parseCatalogQuery } from './numbered-catalog-state.ts';

const fields = CatalogTaxonomySchema.innerType().shape;
const publicTaxonomySchema = z
  .object({
    family: fields.family,
    name: fields.name,
    revision: fields.revision,
    children: z.array(fields.children.element.omit({ status: true })).max(MAX_TAXONOMY_CHILDREN),
  })
  .strict();

export type PublicCatalogTaxonomy = z.infer<typeof publicTaxonomySchema>;

export function decodeCatalogTaxonomy(
  value: unknown,
  family: ProductFamily,
): PublicCatalogTaxonomy {
  const parsed = publicTaxonomySchema.safeParse(value);
  if (!parsed.success || parsed.data.family !== family)
    throw new Error('Unable to load catalog categories.');
  for (const field of ['id', 'slug', 'name'] as const) {
    const values = parsed.data.children.map((child) =>
      child[field].normalize('NFKC').toLowerCase(),
    );
    if (new Set(values).size !== values.length)
      throw new Error('Unable to load catalog categories.');
  }
  return {
    ...parsed.data,
    children: [...parsed.data.children].sort(
      (left, right) => left.order - right.order || left.id.localeCompare(right.id),
    ),
  };
}

async function readCatalogTaxonomy(
  family: ProductFamily,
  signal?: AbortSignal,
): Promise<PublicCatalogTaxonomy> {
  const response = await fetch(apiUrl(`/api/catalog-taxonomy?family=${family}`), { signal });
  if (!response.ok) throw new Error('Unable to load catalog categories.');
  const envelope = await readApiEnvelope<unknown>(response);
  if (!envelope?.ok) throw new Error('Unable to load catalog categories.');
  return decodeCatalogTaxonomy(envelope.data, family);
}

type TaxonomyRead = {
  request: Promise<PublicCatalogTaxonomy>;
  controller: AbortController;
  subscribers: number;
  expiresAt?: number;
};

const recentTaxonomy = new Map<ProductFamily, TaxonomyRead>();
// The header can complete before the catalog island hydrates. Share that short-lived
// snapshot in this document so both use the same public revision.
const taxonomyReuseMs = 5_000;

export async function fetchCatalogTaxonomy(
  family: ProductFamily,
  signal?: AbortSignal,
  mode: 'network' | 'reuse' | 'refresh' = 'network',
): Promise<PublicCatalogTaxonomy> {
  signal?.throwIfAborted();
  if (mode === 'network') return readCatalogTaxonomy(family, signal);

  let read = recentTaxonomy.get(family);
  if (
    !read ||
    (read.expiresAt !== undefined && (mode === 'refresh' || read.expiresAt <= performance.now()))
  ) {
    const controller = new AbortController();
    const request = readCatalogTaxonomy(family, controller.signal);
    const entry: TaxonomyRead = { request, controller, subscribers: 0 };
    recentTaxonomy.set(family, entry);
    void request.then(
      () => {
        entry.expiresAt = performance.now() + taxonomyReuseMs;
      },
      () => {
        if (recentTaxonomy.get(family) === entry) recentTaxonomy.delete(family);
      },
    );
    read = entry;
  }

  read.subscribers++;
  let onAbort: (() => void) | undefined;
  try {
    if (!signal) return await read.request;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([read.request, cancelled]);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    read.subscribers--;
    if (
      read.subscribers === 0 &&
      read.expiresAt === undefined &&
      recentTaxonomy.get(family) === read
    ) {
      recentTaxonomy.delete(family);
      read.controller.abort();
    }
  }
}

export function parseTaxonomyCatalogQuery(
  search: string,
  registry: PublicCatalogTaxonomy | null,
): NumberedCatalogQuery {
  const params = new URLSearchParams(search);
  const query = parseCatalogQuery(search, []);
  const field = params.has('subcategoryIds') ? 'subcategoryIds' : 'category';
  if (!params.has(field)) return { ...query, categories: null };
  const values = params.getAll(field);
  if (field === 'category' && values.length === 1 && values[0] === '__none__')
    return { ...query, categories: [] };
  if (!registry) throw new Error('Unable to load catalog categories.');
  const ids = (values[0] ?? '').split(',').map((value) => {
    if (registry.children.some((child) => child.id === value)) return value;
    if (
      field === 'category' &&
      registry.family === 'headphones' &&
      ['wired', 'office', 'bluetooth'].includes(value)
    )
      return `headphones-${value}`;
    return value;
  });
  if (values.length !== 1 || ids.some((id) => !registry.children.some((child) => child.id === id)))
    throw new Error('The selected catalog categories are no longer available.');
  return { ...query, categories: [...new Set(ids)].sort() };
}
