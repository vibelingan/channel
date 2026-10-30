import { createHash } from 'node:crypto';
import {
  type CatalogAction,
  type PublicProductCard,
  isCatalogAction,
} from '@vibelingan-channel/ai-contracts';
export type ProductPlan =
  | CatalogAction
  | { kind: 'clarify'; question: string }
  | { kind: 'answer'; text: string };

export function parseProductPlan(text: string): ProductPlan {
  if (text.length > 4000) throw new Error('invalid_product_plan');
  const v: unknown = JSON.parse(text);
  if (isCatalogAction(v)) return v;
  if (
    v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.keys(v).length === 2 &&
    'kind' in v
  ) {
    if (
      v.kind === 'clarify' &&
      'question' in v &&
      typeof v.question === 'string' &&
      v.question.trim() &&
      v.question.length <= 500
    )
      return { kind: 'clarify', question: v.question };
    if (
      v.kind === 'answer' &&
      'text' in v &&
      typeof v.text === 'string' &&
      v.text.trim() &&
      v.text.length <= 3500
    )
      return { kind: 'answer', text: v.text };
  }
  throw new Error('invalid_product_plan');
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export class PublicCatalog {
  readonly origin: string;
  constructor(
    origin: string,
    private readonly api: typeof fetch = fetch,
    allowLocal = false,
  ) {
    const u = new URL(origin);
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== '/' ||
      (u.protocol !== 'https:' &&
        !(allowLocal && u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)))
    )
      throw new Error('invalid_public_catalog_origin');
    this.origin = u.origin;
  }
  private async read(path: string, signal: AbortSignal): Promise<unknown> {
    const r = await this.api(this.origin + path, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    if (r.status === 404) {
      await r.body?.cancel();
      return null;
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw new Error('public_catalog_unavailable');
    }
    if (!r.body) throw new Error('public_catalog_unavailable');
    const reader = r.body.getReader();
    let size = 0;
    let body = '';
    const decoder = new TextDecoder();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 262144) throw new Error('public_catalog_too_large');
        body += decoder.decode(part.value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const data: unknown = JSON.parse(body);
    if (!record(data) || data.ok !== true || !('data' in data))
      throw new Error('invalid_public_catalog');
    return data.data;
  }
  private project(raw: unknown): PublicProductCard | null {
    if (
      !record(raw) ||
      raw.published !== true ||
      typeof raw._id !== 'string' ||
      !/^[-a-zA-Z0-9_]{1,128}$/.test(raw._id) ||
      typeof raw.name !== 'string' ||
      !raw.name.trim() ||
      raw.name.length > 200
    )
      return null;
    const summary =
      typeof raw.description === 'string'
        ? raw.description
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 1200)
        : 'See the published product page for available specifications.';
    let imageUrl: string | undefined;
    if (Array.isArray(raw.images) && typeof raw.images[0] === 'string') {
      let u: URL | undefined;
      try {
        u = new URL(raw.images[0], this.origin);
      } catch {
        /* Invalid public media degrades to the image placeholder. */
      }
      if (
        u &&
        u.origin === this.origin &&
        /^\/api\/images\/[a-zA-Z0-9_%.-]+$/.test(u.pathname) &&
        !u.search &&
        !u.hash
      )
        imageUrl = u.pathname;
    }
    const data = {
      id: raw._id,
      name: raw.name,
      summary,
      href: `/products/item/?id=${encodeURIComponent(raw._id)}`,
      ...(imageUrl ? { imageUrl } : {}),
    };
    return {
      ...data,
      revision: `public-${createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 20)}`,
      retrievedAt: new Date().toISOString(),
    };
  }
  async execute(action: CatalogAction, signal: AbortSignal) {
    if (!isCatalogAction(action)) throw new Error('invalid_catalog_action');
    let rows: unknown[];
    if (action.kind === 'search') {
      const data = await this.read(
        `/api/products?search=${encodeURIComponent(action.query.trim())}&pageSize=6`,
        signal,
      );
      if (!record(data) || !Array.isArray(data.items) || data.items.length > 6)
        throw new Error('invalid_public_catalog');
      rows = data.items;
    } else
      rows = await Promise.all(
        action.ids.map((id) => this.read(`/api/products/${encodeURIComponent(id)}`, signal)),
      );
    if (
      action.kind === 'lookup' &&
      rows.some((row, index) => row !== null && (!record(row) || row._id !== action.ids[index]))
    )
      throw new Error('invalid_public_catalog_identity');
    const products = rows
      .map((row) => this.project(row))
      .filter((p): p is PublicProductCard => p !== null);
    if (new Set(products.map((p) => p.id)).size !== products.length)
      throw new Error('invalid_public_catalog');
    return {
      products,
      unavailableProductIds:
        action.kind === 'lookup'
          ? action.ids.filter((id) => !products.some((p) => p.id === id))
          : [],
      kind: action.kind === 'lookup' ? 'product_updated' : products.length ? 'answer' : 'no_match',
      text:
        action.kind === 'lookup'
          ? 'These are the latest published details. Unavailable products have been removed from the current comparison.'
          : products.length
            ? 'Here are published product options matching your request. Compare the options or open a product page for details.'
            : 'I could not find a published product matching that request. Try a broader product type or describe what it will be used for.',
    };
  }
}
