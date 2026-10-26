import type { Nodes, PhrasingContent, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { ArticleBlock, ArticleDocument, ArticleInline, ArticleMark } from './document.ts';

function unsupported(node: Nodes): never {
  throw Error(`Unsupported Markdown ${node.type} at line ${node.position?.start.line ?? 1}`);
}
function inline(nodes: PhrasingContent[], marks: ArticleMark[] = []): ArticleInline[] {
  return nodes.flatMap((node): ArticleInline[] => {
    switch (node.type) {
      case 'text':
        return [{ type: 'text', text: node.value, marks }];
      case 'break':
        return [{ type: 'hardBreak' }];
      case 'inlineCode':
        return [{ type: 'text', text: node.value, marks: [...marks, { type: 'code' }] }];
      case 'strong':
        return inline(node.children, [...marks, { type: 'bold' }]);
      case 'emphasis':
        return inline(node.children, [...marks, { type: 'italic' }]);
      case 'delete':
        return inline(node.children, [...marks, { type: 'strike' }]);
      case 'link':
        return inline(node.children, [
          ...marks,
          { type: 'link', attrs: { href: node.url, target: null, rel: null, class: null } },
        ]);
      default:
        return unsupported(node);
    }
  });
}
function block(node: RootContent): ArticleBlock {
  switch (node.type) {
    case 'paragraph':
      return { type: 'paragraph', attrs: { textAlign: null }, content: inline(node.children) };
    case 'heading':
      if (node.depth === 1) return unsupported(node);
      return {
        type: 'heading',
        attrs: { level: node.depth, textAlign: null },
        content: inline(node.children),
      };
    case 'blockquote':
      return { type: 'blockquote', content: node.children.map(block) };
    case 'list': {
      const content = node.children.map((item) => {
        if (item.checked !== null && item.checked !== undefined) return unsupported(item);
        return { type: 'listItem' as const, content: item.children.map(block) };
      });
      return node.ordered
        ? { type: 'orderedList', attrs: { start: node.start ?? 1 }, content }
        : { type: 'bulletList', content };
    }
    case 'code':
      if (node.meta) return unsupported(node);
      return {
        type: 'codeBlock',
        attrs: { language: node.lang ?? null },
        content: node.value ? [{ type: 'text', text: node.value, marks: [] }] : [],
      };
    case 'thematicBreak':
      return { type: 'horizontalRule' };
    case 'table':
      return {
        type: 'table',
        content: node.children.map((row, index) => ({
          type: 'tableRow',
          content: row.children.map((cell, column) => ({
            type: index === 0 ? 'tableHeader' : 'tableCell',
            attrs: { colspan: 1, rowspan: 1, colwidth: null },
            content: [
              {
                type: 'paragraph',
                attrs: { textAlign: node.align?.[column] ?? null },
                content: inline(cell.children),
              },
            ],
          })),
        })),
      };
    default:
      return unsupported(node);
  }
}
/** Parse with the standard mdast/GFM parser; the existing article validator owns output limits. */
export function markdownArticleDocument(source: string): ArticleDocument {
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return { schemaVersion: 1, document: { type: 'doc', content: tree.children.map(block) } };
}
