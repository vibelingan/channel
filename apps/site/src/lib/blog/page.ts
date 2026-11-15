import { createHash } from 'node:crypto';
import { articleText, renderArticle } from '@vibelingan-channel/articles';
import type { ArticlePageData } from '@vibelingan-channel/articles/build';
import type { ArticleSummary } from '@vibelingan-channel/articles/public-read';
import { articleMediaPath } from '@vibelingan-channel/articles/publication';
import {
  type ArticleWebPresentation,
  parseArticleWebPresentation,
} from '@vibelingan-channel/articles/web-media';
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
export const articlePath = (
  article: ArticlePageData | ArticleSummary,
  location = publicBlogLocation,
) => `${location.root}${article.content.slug}/`;
export const blogMediaPath = (id: string, media: unknown, location = publicBlogLocation) =>
  `${location.mediaPrefix}${articleMediaPath(id, media)}`;
export const articleSummary = (article: ArticlePageData | ArticleSummary) =>
  article.content.excerpt ||
  ('body' in article.content
    ? articleText(article.content.body).replace(/\s+/g, ' ').slice(0, 240)
    : article.content.title);
export const articleDate = (time: string) =>
  new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(time));

function displayMedia(
  article: ArticlePageData,
  location: typeof publicBlogLocation,
  presentation?: ArticleWebPresentation,
) {
  const prepared = presentation ? parseArticleWebPresentation(article, presentation).media : {};
  return Object.fromEntries(
    Object.entries(article.media).map(([id, original]) => {
      const web = Object.hasOwn(prepared, id) ? prepared[id] : undefined;
      return [
        id,
        {
          kind: 'public' as const,
          url: web ? `${location.mediaPrefix}${web.url}` : blogMediaPath(id, original, location),
          mimeType: web?.mimeType ?? original.mimeType,
          width: web?.width ?? original.width,
          height: web?.height ?? original.height,
        },
      ];
    }),
  );
}

export function articleBody(
  article: ArticlePageData,
  location = publicBlogLocation,
  presentation?: ArticleWebPresentation,
): string {
  return renderArticle(article.content.body, {
    mode: 'public',
    media: displayMedia(article, location, presentation),
  }).html;
}

export function articlePage(
  article: ArticlePageData,
  origin: string,
  brand: string,
  location = publicBlogLocation,
  presentation?: ArticleWebPresentation,
) {
  const { content } = article;
  const path = articlePath(article, location);
  const url = canonicalUrl(path, origin);
  const images = Object.values(displayMedia(article, location, presentation)).map(
    (media) => new URL(media.url, origin).href,
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
        author: {
          '@type': content.authorName === brand ? 'Organization' : 'Person',
          name: content.authorName,
        },
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
  articles: (ArticlePageData | ArticleSummary)[],
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
