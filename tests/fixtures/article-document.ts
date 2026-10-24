import { fromTiptapJSON } from '../../packages/articles/src/index.ts';

const text = (value: string) => ({ type: 'text', text: value });
const paragraph = (value: string) => ({ type: 'paragraph', content: [text(value)] });
export const editorContractDocument = fromTiptapJSON({
  type: 'doc',
  content: [
    ...[2, 3, 4].map((level) => ({
      type: 'heading',
      attrs: { level, textAlign: 'center' },
      content: [text(`Heading ${level}`)],
    })),
    {
      type: 'paragraph',
      attrs: { textAlign: 'right' },
      content: [
        ...['bold', 'italic', 'underline', 'strike', 'code'].map((type) => ({
          ...text(type),
          marks: [{ type }],
        })),
        { type: 'hardBreak' },
        {
          ...text('Link'),
          marks: [
            {
              type: 'link',
              attrs: {
                href: 'https://example.com/',
                target: '_blank',
                rel: 'nofollow noopener',
                class: null,
              },
            },
          ],
        },
      ],
    },
    { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('Bullet')] }] },
    {
      type: 'orderedList',
      attrs: { start: 3 },
      content: [{ type: 'listItem', content: [paragraph('Numbered')] }],
    },
    { type: 'blockquote', content: [paragraph('Quote')] },
    { type: 'codeBlock', attrs: { language: 'javascript' }, content: [text('const x = 1;')] },
    { type: 'horizontalRule' },
    {
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', content: [paragraph('Header')] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph('Cell')] }] },
      ],
    },
    {
      type: 'articleImage',
      attrs: {
        mediaId: 'saved-image',
        alt: 'Existing image',
        caption: 'Keep this caption',
        align: 'center',
      },
    },
    paragraph('End of contract document'),
  ],
});
