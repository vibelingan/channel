import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type ArticleContent, parseArticleContent } from './article.ts';
import type { ArticleNode } from './document.ts';
import { markdownArticleDocument } from './import-markdown.ts';

export class ArticleImportError extends Error {
  constructor(
    readonly code:
      | 'INVALID_REQUEST'
      | 'UNAUTHORIZED'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'RATE_LIMITED'
      | 'UNAVAILABLE',
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ArticleImportError';
  }
}
const text = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => v.normalize('NFC').replace(/\r\n?/g, '\n').trim());
const metadata = {
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/),
  externalTaskId: text(200).refine((v) => v.length > 0),
  title: text(200).refine((v) => v.length > 0),
  slug: text(120).default(''),
  excerpt: text(500).default(''),
  authorName: text(120).default(''),
  seoTitle: text(200).default(''),
  seoDescription: text(320).default(''),
};
const schema = z.discriminatedUnion('format', [
  z
    .object({
      ...metadata,
      format: z.literal('markdown'),
      body: z
        .string()
        .min(1)
        .transform((v) => v.normalize('NFC').replace(/\r\n?/g, '\n')),
    })
    .strict(),
  z.object({ ...metadata, format: z.literal('article-json-v1'), body: z.unknown() }).strict(),
]);
export type ArticleImportSource = z.infer<typeof schema>;
export interface PreparedArticleImport {
  source: ArticleImportSource;
  content: ArticleContent;
  requestHash: string;
  converterVersion: 'article-import-v1';
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}
export function importHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}
function textOnly(node: ArticleNode): void {
  if (node.type === 'articleImage') throw Error('Images must be added by a human in the editor');
  if ('content' in node) for (const child of node.content) textOnly(child);
}
/** Identity covers the original, normalized source. Converted Markdown is not the retry identity. */
export function prepareArticleImport(input: unknown): PreparedArticleImport {
  try {
    if (Buffer.byteLength(JSON.stringify(input) ?? '') > 256 * 1024)
      throw Error('Import request exceeds 256 KiB');
    const source = schema.parse(input);
    if (source.format === 'markdown' && Buffer.byteLength(source.body) > 128 * 1024)
      throw Error('Markdown exceeds 128 KiB');
    const {
      idempotencyKey: _key,
      externalTaskId: _task,
      format: _format,
      body,
      ...fields
    } = source;
    const content = parseArticleContent({
      ...fields,
      body: source.format === 'markdown' ? markdownArticleDocument(source.body) : body,
    });
    textOnly(content.body.document);
    return {
      source,
      content,
      requestHash: importHash(source),
      converterVersion: 'article-import-v1',
    };
  } catch (error) {
    if (error instanceof ArticleImportError) throw error;
    throw new ArticleImportError(
      'INVALID_REQUEST',
      error instanceof Error && error.message.startsWith('Unsupported Markdown')
        ? error.message
        : 'Unsupported or invalid article import.',
    );
  }
}
