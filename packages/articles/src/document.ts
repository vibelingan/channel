import { z } from 'zod';

export type ArticleMark =
  | { type: 'bold' | 'italic' | 'underline' | 'strike' | 'code' }
  | {
      type: 'link';
      attrs: { href: string; target: '_blank' | '_self' | null; rel: string | null; class: null };
    };
export type ArticleText = { type: 'text'; text: string; marks: ArticleMark[] };
export type ArticleInline = ArticleText | { type: 'hardBreak' };
type Alignment = 'left' | 'center' | 'right' | null;
export type ArticleParagraph = {
  type: 'paragraph';
  attrs: { textAlign: Alignment };
  content: ArticleInline[];
};
export type ArticleListItem = { type: 'listItem'; content: ArticleBlock[] };
export type ArticleCell = {
  type: 'tableCell' | 'tableHeader';
  attrs: { colspan: 1; rowspan: 1; colwidth: null };
  content: ArticleBlock[];
};
export type ArticleRow = { type: 'tableRow'; content: ArticleCell[] };
export type ArticleBlock =
  | ArticleParagraph
  | { type: 'heading'; attrs: { level: number; textAlign: Alignment }; content: ArticleInline[] }
  | { type: 'bulletList'; content: ArticleListItem[] }
  | { type: 'orderedList'; attrs: { start: number }; content: ArticleListItem[] }
  | { type: 'blockquote'; content: ArticleBlock[] }
  | { type: 'codeBlock'; attrs: { language: string | null }; content: ArticleText[] }
  | { type: 'horizontalRule' }
  | {
      type: 'articleImage';
      attrs: { mediaId: string; alt: string; caption: string; align: 'left' | 'center' | 'right' };
    }
  | { type: 'table'; content: ArticleRow[] };
export type ArticleDocument = {
  schemaVersion: 1;
  document: { type: 'doc'; content: ArticleBlock[] };
};
export type ArticleNode =
  | ArticleDocument['document']
  | ArticleBlock
  | ArticleInline
  | ArticleListItem
  | ArticleCell
  | ArticleRow;

export class ArticleValidationError extends Error {
  readonly code = 'INVALID_ARTICLE_CONTENT';
  constructor(readonly issues: ReadonlyArray<{ path: string; message: string }>) {
    super(issues.map((issue) => `${issue.path || '$'}: ${issue.message}`).join('; '));
    this.name = 'ArticleValidationError';
  }
}

export function safeArticleHref(href: string): boolean {
  if (
    !href ||
    href !== href.trim() ||
    href.includes('\\') ||
    [...href].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  )
    return false;
  if (href.startsWith('#')) return true;
  if (href.startsWith('/')) return !href.startsWith('//');
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

const markSchema = z.union([
  z.object({ type: z.enum(['bold', 'italic', 'underline', 'strike', 'code']) }).strict(),
  z
    .object({
      type: z.literal('link'),
      attrs: z
        .object({
          href: z
            .string()
            .max(4096)
            .refine(safeArticleHref, 'Only root paths, anchors and HTTPS links are supported'),
          target: z.enum(['_blank', '_self']).nullable().default(null),
          rel: z
            .string()
            .max(100)
            .refine((value) =>
              value
                .split(/\s+/)
                .filter(Boolean)
                .every((token) =>
                  ['noopener', 'noreferrer', 'nofollow', 'ugc', 'sponsored'].includes(token),
                ),
            )
            .nullable()
            .default(null),
          class: z.null().default(null),
        })
        .strict(),
    })
    .strict(),
]);
const textSchema: z.ZodType<ArticleText, z.ZodTypeDef, unknown> = z
  .object({
    type: z.literal('text'),
    text: z.string().min(1).max(200000),
    marks: z
      .array(markSchema)
      .max(6)
      .refine(
        (marks) => new Set(marks.map((mark) => mark.type)).size === marks.length,
        'Repeated text mark',
      )
      .default([]),
  })
  .strict();
const inlineSchema = z.union([textSchema, z.object({ type: z.literal('hardBreak') }).strict()]);
const textAlign = z.enum(['left', 'center', 'right']).nullable().default(null);
const paragraphSchema = z
  .object({
    type: z.literal('paragraph'),
    attrs: z.object({ textAlign }).strict().default({ textAlign: null }),
    content: z.array(inlineSchema).default([]),
  })
  .strict();
const listItemSchema: z.ZodType<ArticleListItem, z.ZodTypeDef, unknown> = z.lazy(() =>
  z
    .object({
      type: z.literal('listItem'),
      content: z
        .array(blockSchema)
        .min(1)
        .refine((nodes) => nodes[0]?.type === 'paragraph', 'A list item starts with a paragraph'),
    })
    .strict(),
);
const cellSchema: z.ZodType<ArticleCell, z.ZodTypeDef, unknown> = z.lazy(() =>
  z
    .object({
      type: z.enum(['tableCell', 'tableHeader']),
      attrs: z
        .object({
          colspan: z.literal(1).default(1),
          rowspan: z.literal(1).default(1),
          colwidth: z.null().default(null),
        })
        .strict()
        .default({ colspan: 1, rowspan: 1, colwidth: null }),
      content: z
        .array(blockSchema)
        .min(1)
        .refine((nodes) => !containsTable(nodes), 'Nested tables are not supported'),
    })
    .strict(),
);
const rowSchema = z
  .object({ type: z.literal('tableRow'), content: z.array(cellSchema).min(1).max(12) })
  .strict();
const blockSchema: z.ZodType<ArticleBlock, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.discriminatedUnion('type', [
    paragraphSchema,
    z
      .object({
        type: z.literal('heading'),
        attrs: z.object({ level: z.number().int().min(2).max(6), textAlign }).strict(),
        content: z.array(inlineSchema).default([]),
      })
      .strict(),
    z.object({ type: z.literal('bulletList'), content: z.array(listItemSchema).min(1) }).strict(),
    z
      .object({
        type: z.literal('orderedList'),
        attrs: z
          .object({ start: z.number().int().min(1).max(10000).default(1) })
          .strict()
          .default({ start: 1 }),
        content: z.array(listItemSchema).min(1),
      })
      .strict(),
    z.object({ type: z.literal('blockquote'), content: z.array(blockSchema).min(1) }).strict(),
    z
      .object({
        type: z.literal('codeBlock'),
        attrs: z
          .object({
            language: z
              .string()
              .max(32)
              .regex(/^[A-Za-z0-9_+-]+$/)
              .nullable()
              .default(null),
          })
          .strict()
          .default({ language: null }),
        content: z
          .array(textSchema)
          .refine(
            (nodes) => nodes.every((node) => node.marks.length === 0),
            'Code blocks cannot contain text marks',
          )
          .default([]),
      })
      .strict(),
    z.object({ type: z.literal('horizontalRule') }).strict(),
    z
      .object({
        type: z.literal('articleImage'),
        attrs: z
          .object({
            mediaId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/),
            alt: z.string().trim().min(1).max(300),
            caption: z.string().max(500).default(''),
            align: z.enum(['left', 'center', 'right']).default('center'),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal('table'),
        content: z
          .array(rowSchema)
          .min(1)
          .max(50)
          .refine(
            (rows) => rows.every((row) => row.content.length === rows[0]?.content.length),
            'Table rows must have equal cell counts',
          ),
      })
      .strict(),
  ]),
);

export const ArticleDocumentSchema: z.ZodType<ArticleDocument, z.ZodTypeDef, unknown> = z
  .object({
    schemaVersion: z.literal(1),
    document: z
      .object({ type: z.literal('doc'), content: z.array(blockSchema).default([]) })
      .strict(),
  })
  .strict();

export function parseArticleDocument(input: unknown): ArticleDocument {
  return readArticleInput(ArticleDocumentSchema, input);
}
export function fromTiptapJSON(input: unknown): ArticleDocument {
  return parseArticleDocument({ schemaVersion: 1, document: input });
}
export function toTiptapJSON(input: unknown): ArticleDocument['document'] {
  return parseArticleDocument(input).document;
}
export function readArticleInput<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  input: unknown,
): T {
  checkJsonBudget(input);
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ArticleValidationError(
      result.error.issues
        .slice(0, 20)
        .map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  return result.data;
}

const supportedTypes = new Set([
  'doc',
  'text',
  'hardBreak',
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'articleImage',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'link',
]);
function checkJsonBudget(input: unknown): void {
  const active = new WeakSet<object>();
  const stack: { value: unknown; depth: number; exit?: boolean }[] = [{ value: input, depth: 0 }];
  const encoder = new TextEncoder();
  let count = 0;
  let bytes = 0;
  const fail = (message: string): never => {
    throw new ArticleValidationError([{ path: '$', message }]);
  };
  while (stack.length) {
    const item = stack.pop();
    if (!item) break;
    const { value, depth } = item;
    if (item.exit) {
      if (value && typeof value === 'object') active.delete(value);
      continue;
    }
    if (++count > 20000 || depth > 32) fail('Article exceeds the structure budget');
    if (typeof value === 'string') bytes += encoder.encode(value).length;
    else if (value && typeof value === 'object') {
      if (active.has(value)) fail('Cyclic article input');
      if (Array.isArray(value) && value.length > 20000) fail('Article exceeds the array budget');
      if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        fail('Article must contain plain JSON objects');
      active.add(value);
      stack.push({ value, depth, exit: true });
      const fields = Object.getOwnPropertyDescriptors(value);
      const entries = Object.entries(fields);
      if (entries.length > 20000 || Object.getOwnPropertySymbols(value).length)
        fail('Article exceeds the object budget');
      for (const [key, descriptor] of entries) {
        if (Array.isArray(value) && key === 'length') continue;
        if (descriptor.get || descriptor.set) fail('Article cannot contain accessors');
        bytes += encoder.encode(key).length;
        if (
          key === 'type' &&
          typeof descriptor.value === 'string' &&
          !supportedTypes.has(descriptor.value)
        )
          fail(`Unsupported article node or mark: ${descriptor.value.slice(0, 64)}`);
        stack.push({ value: descriptor.value, depth: depth + 1 });
      }
    } else if (
      value !== null &&
      typeof value !== 'boolean' &&
      !(typeof value === 'number' && Number.isFinite(value))
    )
      fail('Article must contain JSON values');
    if (bytes > 512 * 1024) fail('Article exceeds 512 KiB');
  }
  if (encoder.encode(JSON.stringify(input)).length > 512 * 1024) fail('Article exceeds 512 KiB');
}
function containsTable(nodes: ArticleBlock[]): boolean {
  return nodes.some(
    (node) =>
      node.type === 'table' ||
      (node.type === 'blockquote' && containsTable(node.content)) ||
      ((node.type === 'bulletList' || node.type === 'orderedList') &&
        node.content.some((item) => containsTable(item.content))),
  );
}
