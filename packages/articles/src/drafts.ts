import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type ArticleContent, parseArticleContent } from './article.ts';
import { ArticleValidationError } from './document.ts';
import { articleText } from './render.ts';

export interface PublishedArticleReference {
  revision: number;
  slug: string;
  contentHash: string;
  publishedAt: string;
  modifiedAt: string;
}
export interface ArticleDraft {
  id: string;
  revision: number;
  content: ArticleContent;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  published: PublishedArticleReference | null;
}
type DeepReadonly<T> = T extends object ? { readonly [P in keyof T]: DeepReadonly<T[P]> } : T;
export type ArticleCandidate = DeepReadonly<{
  articleId: string;
  revision: number;
  content: ArticleContent;
  contentHash: string;
  frozenAt: string;
}>;
interface DraftWriter {
  editorId: string;
  now: string;
  content: unknown;
}
const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/);

export function createArticleDraft(input: DraftWriter & { id: string }): ArticleDraft {
  idSchema.parse(input.id);
  idSchema.parse(input.editorId);
  timestamp(input.now);
  return {
    id: input.id,
    revision: 1,
    content: parseArticleContent(input.content),
    createdAt: input.now,
    updatedAt: input.now,
    createdBy: input.editorId,
    updatedBy: input.editorId,
    published: null,
  };
}

/** The repository must perform this check and persist its result in one transaction. */
export function saveArticleDraft(
  current: ArticleDraft,
  input: DraftWriter & { expectedRevision: number },
): ArticleDraft {
  validateDraft(current);
  if (current.revision !== input.expectedRevision) throw new Error('ARTICLE_REVISION_CONFLICT');
  idSchema.parse(input.editorId);
  if (timestamp(input.now) < timestamp(current.updatedAt))
    throw new Error('ARTICLE_CLOCK_MOVED_BACKWARDS');
  const content = parseArticleContent(input.content);
  if (canonical(content) === canonical(current.content)) return structuredClone(current);
  if (current.revision === Number.MAX_SAFE_INTEGER) throw new Error('ARTICLE_REVISION_EXHAUSTED');
  return {
    ...structuredClone(current),
    revision: current.revision + 1,
    content,
    updatedAt: input.now,
    updatedBy: input.editorId,
  };
}

/** Freezes content only. Delivery acceptance, publication timestamps and public visibility belong to the publisher. */
export function prepareArticlePublication(current: ArticleDraft, now: string): ArticleCandidate {
  validateDraft(current);
  if (timestamp(now) < timestamp(current.updatedAt))
    throw new Error('ARTICLE_CLOCK_MOVED_BACKWARDS');
  const content = parseArticleContent(current.content);
  const issues: { path: string; message: string }[] = [];
  if (!content.title)
    issues.push({ path: 'title', message: 'A title is required for publication' });
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(content.slug))
    issues.push({ path: 'slug', message: 'A lowercase hyphenated slug is required' });
  if (!content.authorName)
    issues.push({ path: 'authorName', message: 'An author is required for publication' });
  if (!articleText(content.body))
    issues.push({ path: 'body', message: 'The article body is empty' });
  if (current.published && current.published.slug !== content.slug)
    issues.push({
      path: 'slug',
      message: 'Changing a published URL requires an explicit redirect plan',
    });
  if (issues.length) throw new ArticleValidationError(issues);
  const candidate: ArticleCandidate = {
    articleId: current.id,
    revision: current.revision,
    content,
    contentHash: createHash('sha256').update(canonical(content)).digest('hex'),
    frozenAt: now,
  };
  freeze(candidate);
  return candidate;
}

function validateDraft(draft: ArticleDraft): void {
  idSchema.parse(draft.id);
  idSchema.parse(draft.createdBy);
  idSchema.parse(draft.updatedBy);
  if (
    !Number.isSafeInteger(draft.revision) ||
    draft.revision < 1 ||
    timestamp(draft.createdAt) > timestamp(draft.updatedAt)
  )
    throw new Error('INVALID_ARTICLE_DRAFT');
  if (
    draft.published &&
    (!Number.isSafeInteger(draft.published.revision) ||
      draft.published.revision < 1 ||
      draft.published.revision > draft.revision ||
      !/^[a-f0-9]{64}$/.test(draft.published.contentHash) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.published.slug) ||
      timestamp(draft.published.publishedAt) > timestamp(draft.published.modifiedAt))
  )
    throw new Error('INVALID_ARTICLE_PUBLICATION_REFERENCE');
  parseArticleContent(draft.content);
}
function timestamp(value: string): number {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
    throw new Error('INVALID_ARTICLE_TIMESTAMP');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    throw new Error('INVALID_ARTICLE_TIMESTAMP');
  return parsed;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Invalid canonical article value');
  return encoded;
}
function freeze(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
