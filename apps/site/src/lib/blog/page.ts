import { createHash } from 'node:crypto';
import { articleText, renderArticle } from '@vibelingan-channel/articles';
import { type PublishedArticle, articleMediaPath } from '@vibelingan-channel/articles/publication';
import { canonicalUrl, createPageDescriptor } from '../seo/page.ts';

export const blogCopy = {
  title: 'Insights',
  description: 'Guides and practical notes on product development, sourcing and manufacturing.',
};
export const articlePath = (article: PublishedArticle) => `/blog/${article.content.slug}/`;
export const articleSummary = (article: PublishedArticle) =>
  article.content.excerpt || articleText(article.content.body).replace(/\s+/g, ' ').slice(0, 240);
export const articleDate = (time: string) =>
  new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(time));

export function articleBody(article: PublishedArticle): string {
  return renderArticle(article.content.body, {
    mode: 'public',
    media: Object.fromEntries(
      Object.entries(article.media).map(([id, media]) => [
        id,
        {
          kind: 'public',
          url: articleMediaPath(id, media),
          mimeType: media.mimeType,
          width: media.width,
          height: media.height,
        },
      ]),
    ),
  }).html;
}

export function articlePage(article: PublishedArticle, origin: string, brand: string) {
  const { content } = article;
  const path = articlePath(article);
  const url = canonicalUrl(path, origin);
  const images = Object.entries(article.media).map(
    ([id, media]) => new URL(articleMediaPath(id, media), origin).href,
  );
  return createPageDescriptor({
    path,
    kind: 'article',
    title: `${content.seoTitle || content.title} | ${brand}`,
    description: content.seoDescription || articleSummary(article),
    content: {
      source: 'accepted-article-publication',
      revision: article.contentHash,
      updatedAt: article.modifiedAt,
    },
    schemaNodes: [
      {
        '@type': 'Article',
        headline: content.title,
        description: articleSummary(article),
        url,
        mainEntityOfPage: { '@type': 'WebPage', '@id': url },
        author: { '@type': 'Person', name: content.authorName },
        datePublished: article.publishedAt,
        dateModified: article.modifiedAt,
        ...(images.length ? { image: images } : {}),
      },
      breadcrumb(
        [
          { name: 'Home', path: '/' },
          { name: blogCopy.title, path: '/blog/' },
          { name: content.title, path },
        ],
        origin,
      ),
    ],
  });
}

export function blogPage(articles: PublishedArticle[], origin: string, brand: string) {
  if (!articles.length) throw new Error('An empty Blog does not create an indexable shell');
  const rows = [...articles].sort((a, b) => a.articleId.localeCompare(b.articleId));
  return createPageDescriptor({
    path: '/blog/',
    kind: 'collection',
    title: `${blogCopy.title} | ${brand}`,
    description: blogCopy.description,
    content: {
      source: 'accepted-article-index',
      revision: createHash('sha256')
        .update(
          JSON.stringify(
            rows.map((article) => [
              article.articleId,
              article.contentHash,
              article.publishedAt,
              article.modifiedAt,
            ]),
          ),
        )
        .digest('hex'),
      updatedAt: rows
        .map((article) => article.modifiedAt)
        .sort()
        .at(-1),
    },
    schemaNodes: [
      breadcrumb(
        [
          { name: 'Home', path: '/' },
          { name: blogCopy.title, path: '/blog/' },
        ],
        origin,
      ),
    ],
  });
}

function breadcrumb(items: { name: string; path: string }[], origin: string) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: canonicalUrl(item.path, origin),
    })),
  };
}
