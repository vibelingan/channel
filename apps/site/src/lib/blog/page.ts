import { createHash } from 'node:crypto';
import { articleText, renderArticle } from '@vibelingan-channel/articles';
import type { ArticlePageData } from '@vibelingan-channel/articles/build';
import { articleMediaPath } from '@vibelingan-channel/articles/publication';
import { canonicalUrl, createPageDescriptor } from '../seo/page.ts';

export const blogCopy = {
  title: 'Insights',
  description: 'Guides and practical notes on product development, sourcing and manufacturing.',
};
export const publicBlogLocation = { root: '/blog/', mediaPrefix: '', dummy: false };
export const dummyBlogLocation = {
  root: '/__blog-dummy/',
  mediaPrefix: '/__blog-dummy',
  dummy: true,
};
export const articlePath = (article: ArticlePageData, location = publicBlogLocation) =>
  `${location.root}${article.content.slug}/`;
export const blogMediaPath = (id: string, media: unknown, location = publicBlogLocation) =>
  `${location.mediaPrefix}${articleMediaPath(id, media)}`;
export const articleSummary = (article: ArticlePageData) =>
  article.content.excerpt || articleText(article.content.body).replace(/\s+/g, ' ').slice(0, 240);
export const articleDate = (time: string) =>
  new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(time));

export function articleBody(article: ArticlePageData, location = publicBlogLocation): string {
  return renderArticle(article.content.body, {
    mode: 'public',
    media: Object.fromEntries(
      Object.entries(article.media).map(([id, media]) => [
        id,
        {
          kind: 'public',
          url: blogMediaPath(id, media, location),
          mimeType: media.mimeType,
          width: media.width,
          height: media.height,
        },
      ]),
    ),
  }).html;
}

export function articlePage(
  article: ArticlePageData,
  origin: string,
  brand: string,
  location = publicBlogLocation,
) {
  const { content } = article;
  const path = articlePath(article, location);
  const url = canonicalUrl(path, origin);
  const images = Object.entries(article.media).map(
    ([id, media]) => new URL(blogMediaPath(id, media, location), origin).href,
  );
  return createPageDescriptor({
    path,
    kind: 'article',
    ...(location.dummy ? { robots: 'noindex,nofollow' as const } : {}),
    title: `${content.seoTitle || content.title} | ${brand}`,
    description: content.seoDescription || articleSummary(article),
    content: {
      source:
        article.status === 'candidate'
          ? 'article-release-candidate'
          : 'accepted-article-publication',
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
          { name: blogCopy.title, path: location.root },
          { name: content.title, path },
        ],
        origin,
      ),
    ],
  });
}

export function blogPage(
  articles: ArticlePageData[],
  origin: string,
  brand: string,
  location = publicBlogLocation,
) {
  const rows = [...articles].sort((a, b) => a.articleId.localeCompare(b.articleId));
  return createPageDescriptor({
    path: location.root,
    kind: 'collection',
    ...(location.dummy
      ? { robots: 'noindex,nofollow' as const }
      : !articles.length
        ? { robots: 'noindex,follow' as const }
        : {}),
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
          { name: blogCopy.title, path: location.root },
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
