import { createHash } from 'node:crypto';
import {
  type CatalogAction,
  type PublicProductCard,
  isCatalogAction,
} from '@vibelingan-channel/ai-contracts';
export type CatalogPlan = CatalogAction & { fallbackQuery?: string };
export type ProductPlan =
  | CatalogPlan
  | { kind: 'clarify'; question: string }
  | { kind: 'inquiry'; summary: string; productId?: string }
  | { kind: 'help'; topic: 'greeting' | 'unsupported' | 'no_knowledge' | 'handoff' }
  | { kind: 'answer'; text: string };

export function parseProductPlan(text: string): ProductPlan {
  if (text.length > 6000) throw new Error('invalid_product_plan');
  const v: unknown = JSON.parse(text);
  if (isCatalogAction(v)) return v;
  if (
    record(v) &&
    v.kind === 'search' &&
    Object.keys(v).every((key) => ['kind', 'query', 'fallbackQuery'].includes(key)) &&
    typeof v.query === 'string' &&
    isCatalogAction({ kind: 'search', query: v.query }) &&
    typeof v.fallbackQuery === 'string' &&
    v.fallbackQuery.trim() &&
    v.fallbackQuery.length <= 80
  )
    return { kind: 'search', query: v.query, fallbackQuery: v.fallbackQuery.trim() };
  if (
    record(v) &&
    v.kind === 'inquiry' &&
    Object.keys(v).every((k) => ['kind', 'summary', 'productId'].includes(k)) &&
    typeof v.summary === 'string' &&
    v.summary.trim() &&
    v.summary.length <= 4000 &&
    (v.productId === undefined ||
      (typeof v.productId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v.productId)))
  )
    return {
      kind: 'inquiry',
      summary: v.summary,
      ...(typeof v.productId === 'string' ? { productId: v.productId } : {}),
    };
  if (
    record(v) &&
    Object.keys(v).length === 2 &&
    v.kind === 'help' &&
    ['greeting', 'unsupported', 'no_knowledge', 'handoff'].some((topic) => topic === v.topic)
  )
    return {
      kind: 'help',
      topic: v.topic as 'greeting' | 'unsupported' | 'no_knowledge' | 'handoff',
    };
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
    private readonly timeoutMs = 15000,
  ) {
    const u = new URL(origin);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000)
      throw new Error('invalid_catalog_timeout');
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
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
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
  async execute(action: CatalogPlan, signal: AbortSignal) {
    const { fallbackQuery, ...base } = action;
    if (
      !isCatalogAction(base) ||
      (fallbackQuery !== undefined &&
        (base.kind !== 'search' ||
          typeof fallbackQuery !== 'string' ||
          !fallbackQuery.trim() ||
          fallbackQuery.length > 80))
    )
      throw new Error('invalid_catalog_action');
    let rows: unknown[];
    let broadened = false;
    if (action.kind === 'search') {
      const search = async (query: string) => {
        const data = await this.read(
          `/api/products?search=${encodeURIComponent(query.trim())}&pageSize=6`,
          signal,
        );
        if (!record(data) || !Array.isArray(data.items) || data.items.length > 6)
          throw new Error('invalid_public_catalog');
        return data.items;
      };
      rows = await search(action.query);
      if (
        !rows.length &&
        fallbackQuery &&
        fallbackQuery.trim().toLowerCase() !== action.query.trim().toLowerCase()
      ) {
        broadened = true;
        rows = await search(fallbackQuery);
      }
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
            ? broadened
              ? 'Here are broader published product options. Our team needs to confirm the requested features and customization.'
              : 'Here are published product options matching your request. Compare the options or open a product page for details.'
            : 'I could not find a published product matching that request. Try a broader product type or describe what it will be used for.',
    };
  }
}
