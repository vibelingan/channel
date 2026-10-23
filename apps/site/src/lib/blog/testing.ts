import { parseArticleContent } from '@vibelingan-channel/articles';
import { createArticleDraft, prepareArticlePublication } from '@vibelingan-channel/articles/drafts';
import type { PublishedArticle } from '@vibelingan-channel/articles/publication';

export function publishedArticleFixture(slug = 'manufacturing-guide'): PublishedArticle {
  const time = '2026-10-21T10:00:00.000Z';
  const candidate = prepareArticlePublication(
    createArticleDraft({
      id: `article-${slug}`,
      editorId: 'test-admin',
      now: time,
      content: {
        title: 'A guide to OEM manufacturing',
        slug,
        excerpt: 'From the first brief to production: planning an OEM project.',
        authorName: 'Example editor',
        body: {
          schemaVersion: 1,
          document: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'A useful manufacturing brief explains the product, its users and the target market.',
                  },
                ],
              },
              {
                type: 'heading',
                attrs: { level: 2 },
                content: [{ type: 'text', text: 'Start with the product brief' }],
              },
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Agree on dimensions, materials and sample acceptance before production.',
                  },
                ],
              },
              {
                type: 'table',
                content: [
                  {
                    type: 'tableRow',
                    content: [
                      {
                        type: 'tableHeader',
                        content: [
                          { type: 'paragraph', content: [{ type: 'text', text: 'Stage' }] },
                        ],
                      },
                      {
                        type: 'tableHeader',
                        content: [
                          { type: 'paragraph', content: [{ type: 'text', text: 'Deliverable' }] },
                        ],
                      },
                    ],
                  },
                  {
                    type: 'tableRow',
                    content: [
                      {
                        type: 'tableCell',
                        content: [
                          { type: 'paragraph', content: [{ type: 'text', text: 'Sampling' }] },
                        ],
                      },
                      {
                        type: 'tableCell',
                        content: [
                          {
                            type: 'paragraph',
                            content: [{ type: 'text', text: 'An agreed reference sample' }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    }),
    time,
  );
  return {
    status: 'accepted',
    deliveryId: 'local-test-delivery',
    articleId: candidate.articleId,
    revision: candidate.revision,
    contentHash: candidate.contentHash,
    content: parseArticleContent(candidate.content),
    publishedAt: time,
    modifiedAt: time,
    acceptedAt: '2026-10-21T10:01:00.000Z',
    media: {},
  };
}
