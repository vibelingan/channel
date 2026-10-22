import { Node } from '@tiptap/core';
import Link from '@tiptap/extension-link';
import { OrderedList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import StarterKit from '@tiptap/starter-kit';
import { safeArticleHref } from '@vibelingan-channel/articles/document';

const link = Link.extend({
  addAttributes() {
    return Object.fromEntries(
      Object.entries(this.parent?.() ?? {}).filter(([name]) => name !== 'title'),
    );
  },
}).configure({
  openOnClick: false,
  autolink: false,
  linkOnPaste: false,
  HTMLAttributes: { rel: null, target: null, class: null },
  isAllowedUri: (href) => safeArticleHref(href),
});
const ordered = OrderedList.extend({
  addAttributes() {
    return {
      start: { default: 1, parseHTML: (element) => Number(element.getAttribute('start') || 1) },
    };
  },
});
const cellAttributes = () => ({
  colspan: { default: 1 },
  rowspan: { default: 1 },
  colwidth: { default: null },
});
const cell = TableCell.extend({ addAttributes: cellAttributes });
const header = TableHeader.extend({ addAttributes: cellAttributes });
// Images remain opaque media references until the dedicated media module is connected.
const image = Node.create({
  name: 'articleImage',
  group: 'block',
  atom: true,
  draggable: false,
  addAttributes() {
    return {
      mediaId: { default: '' },
      alt: { default: '' },
      caption: { default: '' },
      align: { default: 'center' },
    };
  },
  parseHTML() {
    return [];
  },
  renderHTML({ node }) {
    return [
      'div',
      {
        'data-article-image': node.attrs.mediaId,
        contenteditable: 'false',
        class: 'rounded-lg border bg-slate-50 p-4 text-sm text-slate-600',
      },
      `Image: ${node.attrs.alt || 'Saved image'} · preview available after media integration`,
    ];
  },
});
export function articleExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3, 4] },
      orderedList: false,
      trailingNode: false,
      link: false,
    }),
    link,
    ordered,
    TextAlign.configure({
      types: ['heading', 'paragraph'],
      alignments: ['left', 'center', 'right'],
      defaultAlignment: null,
    }),
    Table.configure({ resizable: false }),
    TableRow,
    cell,
    header,
    image,
  ];
}
