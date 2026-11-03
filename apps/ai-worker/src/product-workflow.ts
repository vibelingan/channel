import { createHash } from 'node:crypto';
import {
  type CatalogAction,
  PRODUCT_BATCH_SIZE,
  type ProductResultSet,
  type PublicProductCard,
  isCatalogAction,
  isFeatureList,
} from '@vibelingan-channel/ai-contracts';
export type CatalogPlan = CatalogAction & { fallbackQuery?: string; must?: string[] };
/** Candidates read per catalog request; the visitor sees PRODUCT_BATCH_SIZE of them. */
export const CANDIDATE_PAGE_SIZE = 20;
/**
 * Where the next batch starts. Kept in the stored answer for the worker only:
 * the BFF rebuilds public fields by name and never forwards it, so a visitor
 * asks for "more" by naming their own question, never a query or a page.
 */
export interface CatalogCursor {
  query: string;
  must: string[];
  page: number;
  seen: string[];
  batch: number;
}
export function isCatalogCursor(v: unknown): v is CatalogCursor {
  return (
    record(v) &&
    typeof v.query === 'string' &&
    isCatalogAction({ kind: 'search', query: v.query }) &&
    Array.isArray(v.must) &&
    (v.must.length === 0 || isFeatureList(v.must)) &&
    Number.isSafeInteger(v.page) &&
    (v.page as number) >= 1 &&
    (v.page as number) <= 50 &&
    Array.isArray(v.seen) &&
    v.seen.length <= 200 &&
    v.seen.every((id) => typeof id === 'string' && /^[-a-zA-Z0-9_]{1,128}$/.test(id)) &&
    Number.isSafeInteger(v.batch) &&
    (v.batch as number) >= 1 &&
    (v.batch as number) < 20
  );
}
/**
 * Public facts that show a feature. ANC and ENC are different things, and a
 * plain "noise reduction" proves neither.
 */
const FEATURE_EVIDENCE: Array<{ asked: RegExp; shown: RegExp }> = [
  {
    asked: /\banc\b|active noise|主动降噪/i,
    shown: /\banc\b|active noise[- ]cancel|主动降噪/i,
  },
  {
    asked: /\benc\b|environmental noise|call noise|通话降噪/i,
    shown: /\benc\b|environmental noise[- ]cancel|通话降噪/i,
  },
  {
    asked: /noise|降噪/i,
    shown: /\banc\b|\benc\b|noise[- ]cancel|noise reduction|降噪/i,
  },
];
export function featureShown(feature: string, facts: string): boolean {
  const rule = FEATURE_EVIDENCE.find((entry) => entry.asked.test(feature));
  if (rule) return rule.shown.test(facts);
  const plain = (text: string) => text.toLowerCase().replace(/[\s_-]+/g, ' ');
  return plain(facts).includes(plain(feature.trim()));
}
export type ProductPlan =
  | (Exclude<CatalogAction, { kind: 'more' }> & { fallbackQuery?: string; must?: string[] })
  | { kind: 'clarify'; question: string }
  | { kind: 'inquiry'; summary: string; productId?: string }
  | { kind: 'help'; topic: 'greeting' | 'unsupported' | 'no_knowledge' | 'handoff' }
  | { kind: 'answer'; text: string };

export function parseProductPlan(text: string): ProductPlan {
  if (text.length > 6000) throw new Error('invalid_product_plan');
  const v: unknown = JSON.parse(text);
  // Only a visitor's click asks for the next batch; the model never picks a cursor.
  if (isCatalogAction(v) && v.kind !== 'more') return v;
  if (
    record(v) &&
    v.kind === 'search' &&
    Object.keys(v).every((key) => ['kind', 'query', 'fallbackQuery', 'must'].includes(key)) &&
    typeof v.query === 'string' &&
    isCatalogAction({ kind: 'search', query: v.query }) &&
    (v.fallbackQuery === undefined ||
      (typeof v.fallbackQuery === 'string' &&
        v.fallbackQuery.trim() &&
        v.fallbackQuery.length <= 80)) &&
    (v.must === undefined || isFeatureList(v.must)) &&
    (v.fallbackQuery !== undefined || v.must !== undefined)
  )
    return {
      kind: 'search',
      query: v.query,
      ...(typeof v.fallbackQuery === 'string' ? { fallbackQuery: v.fallbackQuery.trim() } : {}),
      ...(isFeatureList(v.must) ? { must: v.must.map((feature) => feature.trim()) } : {}),
    };
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
  /** One page of keyword candidates, in the catalog's own stable order. */
  private async candidates(query: string, page: number, signal: AbortSignal) {
    const data = await this.read(
      `/api/products?search=${encodeURIComponent(query.trim())}&pageSize=${CANDIDATE_PAGE_SIZE}&page=${page}`,
      signal,
    );
    if (!record(data) || !Array.isArray(data.items) || data.items.length > CANDIDATE_PAGE_SIZE)
      throw new Error('invalid_public_catalog');
    const total = Number.isSafeInteger(data.total) ? (data.total as number) : undefined;
    return {
      items: data.items,
      // Without a total, only a full page suggests there may be another.
      morePages:
        total === undefined
          ? data.items.length === CANDIDATE_PAGE_SIZE
          : total > page * CANDIDATE_PAGE_SIZE,
    };
  }
  /**
   * Up to PRODUCT_BATCH_SIZE unseen products, those whose public facts show
   * every required feature first; the rest are marked with what to confirm.
   * Order within each group is the catalog's, so a batch never reshuffles.
   */
  private async batch(cursor: CatalogCursor, signal: AbortSignal) {
    const seen = new Set(cursor.seen);
    let page = cursor.page;
    let read = await this.candidates(cursor.query, page, signal);
    let pool = this.unseen(read.items, seen);
    // One extra read at most, when this page is nearly used up.
    if (pool.length < PRODUCT_BATCH_SIZE && read.morePages && page < 50) {
      page += 1;
      read = await this.candidates(cursor.query, page, signal);
      pool = [...pool, ...this.unseen(read.items, new Set([...seen, ...pool.map((p) => p.id)]))];
    }
    const ranked = pool
      .map((product) => {
        const facts = `${product.name} ${product.summary}`;
        const toConfirm = cursor.must.filter((feature) => !featureShown(feature, facts));
        return toConfirm.length ? { ...product, toConfirm } : product;
      })
      .sort((a, b) => Number(Boolean(a.toConfirm)) - Number(Boolean(b.toConfirm)));
    const products = ranked.slice(0, PRODUCT_BATCH_SIZE);
    const hasMore = ranked.length > PRODUCT_BATCH_SIZE || read.morePages;
    const next: CatalogCursor = {
      ...cursor,
      // Leftovers of this page are read again next time, minus what was shown.
      page,
      seen: [...cursor.seen, ...products.map((p) => p.id)].slice(-200),
      batch: cursor.batch + 1,
    };
    const resultSet: ProductResultSet = { batch: cursor.batch, hasMore };
    return { products, resultSet, ...(hasMore ? { catalogCursor: next } : {}) };
  }
  private unseen(rows: unknown[], seen: Set<string>) {
    const products = rows
      .map((row) => this.project(row))
      .filter((p): p is PublicProductCard => p !== null);
    if (new Set(products.map((p) => p.id)).size !== products.length)
      throw new Error('invalid_public_catalog');
    return products.filter((p) => !seen.has(p.id));
  }
  async execute(action: CatalogPlan, signal: AbortSignal, after?: CatalogCursor) {
    const { fallbackQuery, must, ...base } = action;
    if (
      !isCatalogAction(base) ||
      (fallbackQuery !== undefined &&
        (base.kind !== 'search' ||
          typeof fallbackQuery !== 'string' ||
          !fallbackQuery.trim() ||
          fallbackQuery.length > 80)) ||
      (must !== undefined && (base.kind !== 'search' || !isFeatureList(must))) ||
      (base.kind === 'more') !== (after !== undefined)
    )
      throw new Error('invalid_catalog_action');
    if (base.kind === 'more') {
      if (!after) throw new Error('invalid_catalog_action');
      const result = await this.batch(after, signal);
      return {
        ...result,
        unavailableProductIds: [],
        kind: result.products.length ? 'answer' : 'no_match',
        text: result.products.length
          ? 'Here are more published options for the same request.'
          : 'There are no more published options for this request. Try a broader product type or describe what it will be used for.',
      };
    }
    if (base.kind === 'search') {
      const first = (query: string): CatalogCursor => ({
        query: query.trim(),
        must: must ?? [],
        page: 1,
        seen: [],
        batch: 1,
      });
      let result = await this.batch(first(base.query), signal);
      let broadened = false;
      if (
        !result.products.length &&
        fallbackQuery &&
        fallbackQuery.trim().toLowerCase() !== base.query.trim().toLowerCase()
      ) {
        broadened = true;
        result = await this.batch(first(fallbackQuery), signal);
      }
      const unconfirmed = result.products.some((p) => p.toConfirm);
      return {
        ...result,
        unavailableProductIds: [],
        kind: result.products.length ? 'answer' : 'no_match',
        text: !result.products.length
          ? 'I could not find a published product matching that request. Try a broader product type or describe what it will be used for.'
          : broadened
            ? 'Here are broader published product options. Our team needs to confirm the requested features and customization.'
            : unconfirmed
              ? 'Here are published product options. Features marked "to confirm" are not shown in their public details, so our team needs to confirm them.'
              : 'Here are published product options matching your request. Open a product page for details.',
      };
    }
    const rows = await Promise.all(
      base.ids.map((id) => this.read(`/api/products/${encodeURIComponent(id)}`, signal)),
    );
    if (rows.some((row, index) => row !== null && (!record(row) || row._id !== base.ids[index])))
      throw new Error('invalid_public_catalog_identity');
    const products = rows
      .map((row) => this.project(row))
      .filter((p): p is PublicProductCard => p !== null);
    if (new Set(products.map((p) => p.id)).size !== products.length)
      throw new Error('invalid_public_catalog');
    return {
      products,
      unavailableProductIds: base.ids.filter((id) => !products.some((p) => p.id === id)),
      kind: 'product_updated',
      text: 'These are the latest published details. Unavailable products have been removed from the current comparison.',
    };
  }
}
