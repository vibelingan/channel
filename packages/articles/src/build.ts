import { z } from 'zod';
import { articleIdentity } from './media.ts';
import {
  type PublishedArticle,
  articlePageDataShape,
  checkArticlePageData,
  parsePublishedArticle,
} from './publication.ts';

const candidateSchema = z
  .object({
    ...articlePageDataShape,
    status: z.literal('candidate'),
    taskId: articleIdentity,
  })
  .strict();
export type ArticleBuildCandidate = z.infer<typeof candidateSchema>;
export type ArticlePageData = PublishedArticle | ArticleBuildCandidate;
export function parseArticleBuildCandidate(input: unknown): ArticleBuildCandidate {
  return checkArticlePageData(candidateSchema.parse(input));
}
const inputSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal('article-release'),
    taskId: articleIdentity,
    operation: z.enum(['publish', 'withdraw']),
    articleId: articleIdentity,
    revision: z.number().int().positive().safe(),
    accepted: z.array(z.unknown()).max(1000),
    candidate: z.unknown(),
  })
  .strict();

/** Trusted build input only. Candidates never enter the public accepted export. */
export function prepareArticleBuild(input: unknown, expectedTaskId: string): ArticlePageData[] {
  const value = inputSchema.parse(input);
  if (value.taskId !== articleIdentity.parse(expectedTaskId))
    throw new Error('Article build task mismatch');
  const accepted = value.accepted.map(parsePublishedArticle);
  const previous = accepted.find((article) => article.articleId === value.articleId);
  let articles: ArticlePageData[];
  if (value.operation === 'withdraw') {
    if (value.candidate !== null || !previous || previous.revision > value.revision)
      throw new Error('Invalid withdrawal build');
    articles = accepted.filter((article) => article.articleId !== value.articleId);
  } else {
    const candidate = parseArticleBuildCandidate(value.candidate);
    if (
      candidate.taskId !== value.taskId ||
      candidate.articleId !== value.articleId ||
      candidate.revision !== value.revision ||
      (previous &&
        (previous.revision >= candidate.revision ||
          previous.content.slug !== candidate.content.slug ||
          previous.publishedAt !== candidate.publishedAt ||
          previous.modifiedAt > candidate.modifiedAt))
    )
      throw new Error('Article candidate does not match the requested revision');
    articles = [...accepted.filter((article) => article.articleId !== value.articleId), candidate];
  }
  checkArticleInventory(accepted);
  checkArticleInventory(articles);
  return articles.sort(
    (a, b) =>
      b.publishedAt.localeCompare(a.publishedAt) || a.content.slug.localeCompare(b.content.slug),
  );
}

export function checkArticleInventory(articles: ArticlePageData[]): void {
  const ids = new Set<string>();
  const slugs = new Set<string>();
  const images = new Set<string>();
  if (articles.length > 1000) throw new Error('Article inventory limit exceeded');
  for (const article of articles) {
    if (ids.has(article.articleId) || slugs.has(article.content.slug))
      throw new Error('Duplicate Blog article identity');
    ids.add(article.articleId);
    slugs.add(article.content.slug);
    for (const id of Object.keys(article.media)) {
      if (images.has(id)) throw new Error('Article media cannot belong to two articles');
      images.add(id);
    }
  }
}
