import { z } from 'zod';
import {
  type ArticleMark,
  type ArticleNode,
  parseArticleDocument,
  readArticleInput,
  safeArticleHref,
} from './document.ts';

export interface RenderOptions {
  mode: 'public' | 'preview';
  media: Readonly<Record<string, unknown>>;
  previewOrigin?: string;
}
const mediaSchema = z
  .object({
    kind: z.enum(['public', 'private-preview']),
    url: z.string().min(1).max(4096),
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']),
    width: z.number().int().min(1).max(16384),
    height: z.number().int().min(1).max(16384),
  })
  .strict();

export function renderArticle(
  input: unknown,
  options: RenderOptions,
): { html: string; text: string; mediaIds: string[] } {
  const doc = parseArticleDocument(input);
  if (!['public', 'preview'].includes(options.mode))
    throw new Error('Explicit article render mode required');
  const mediaIds = new Set<string>();
  const children = (nodes: ArticleNode[]) => nodes.map(html).join('');
  const alignment = (value: string | null) => (value ? ` class="article-align-${value}"` : '');
  function html(node: ArticleNode): string {
    switch (node.type) {
      case 'doc':
        return children(node.content);
      case 'text':
        return node.marks.reduce(markHtml, escapeHtml(node.text));
      case 'hardBreak':
        return '<br>';
      case 'horizontalRule':
        return '<hr>';
      case 'paragraph':
        return `<p${alignment(node.attrs.textAlign)}>${children(node.content)}</p>`;
      case 'heading':
        return `<h${node.attrs.level}${alignment(node.attrs.textAlign)}>${children(node.content)}</h${node.attrs.level}>`;
      case 'blockquote':
        return `<blockquote>${children(node.content)}</blockquote>`;
      case 'bulletList':
        return `<ul>${children(node.content)}</ul>`;
      case 'orderedList':
        return `<ol${node.attrs.start === 1 ? '' : ` start="${node.attrs.start}"`}>${children(node.content)}</ol>`;
      case 'listItem':
        return `<li>${children(node.content)}</li>`;
      case 'codeBlock':
        return `<pre><code${node.attrs.language ? ` class="language-${node.attrs.language}"` : ''}>${children(node.content)}</code></pre>`;
      case 'table':
        return `<table><tbody>${children(node.content)}</tbody></table>`;
      case 'tableRow':
        return `<tr>${children(node.content)}</tr>`;
      case 'tableCell':
        return `<td>${children(node.content)}</td>`;
      case 'tableHeader':
        return `<th>${children(node.content)}</th>`;
      case 'articleImage': {
        const id = node.attrs.mediaId;
        if (!Object.hasOwn(options.media, id))
          throw new Error(`Article media is unavailable: ${id}`);
        const media = readArticleInput(mediaSchema, options.media[id]);
        if (media.kind === 'private-preview') {
          if (options.mode !== 'preview' || !validPreviewUrl(media.url, options.previewOrigin))
            throw new Error('Private article media requires a same-origin preview object URL');
        } else if (!safeArticleHref(media.url) || media.url.startsWith('#'))
          throw new Error('Invalid public article image URL');
        mediaIds.add(id);
        return `<figure class="article-image article-image-${node.attrs.align}"><img src="${escapeHtml(media.url)}" alt="${escapeHtml(node.attrs.alt)}" width="${media.width}" height="${media.height}" loading="lazy" decoding="async">${node.attrs.caption ? `<figcaption>${escapeHtml(node.attrs.caption)}</figcaption>` : ''}</figure>`;
      }
    }
  }
  return { html: html(doc.document), text: articleText(doc), mediaIds: [...mediaIds] };
}

export function articleText(input: unknown): string {
  const doc = parseArticleDocument(input);
  function text(node: ArticleNode): string {
    if (node.type === 'text') return node.text;
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'horizontalRule') return '';
    if (node.type === 'articleImage') return node.attrs.caption || node.attrs.alt;
    return node.content
      .map(text)
      .join(
        ['paragraph', 'heading', 'codeBlock'].includes(node.type)
          ? ''
          : node.type === 'tableRow'
            ? '\t'
            : '\n',
      );
  }
  return text(doc.document).trim();
}

function markHtml(value: string, mark: ArticleMark): string {
  if (mark.type === 'link') {
    const rel = new Set(mark.attrs.target === '_blank' ? ['noopener', 'noreferrer'] : []);
    for (const token of mark.attrs.rel?.split(/\s+/).filter(Boolean) ?? []) rel.add(token);
    return `<a href="${escapeHtml(mark.attrs.href)}"${mark.attrs.target ? ` target="${mark.attrs.target}"` : ''}${rel.size ? ` rel="${[...rel].join(' ')}"` : ''}>${value}</a>`;
  }
  const tags = { bold: 'strong', italic: 'em', underline: 'u', strike: 's', code: 'code' };
  const tag = tags[mark.type];
  return `<${tag}>${value}</${tag}>`;
}
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function validPreviewUrl(value: string, origin: string | undefined): boolean {
  if (!origin || !value.startsWith('blob:')) return false;
  try {
    const base = new URL(origin);
    return (
      ['https:', 'http:'].includes(base.protocol) &&
      base.origin === origin &&
      new URL(value).origin === origin
    );
  } catch {
    return false;
  }
}
