import { articleIdentity } from '@vibelingan-channel/articles/media';
import { parsePublishedArticle } from '@vibelingan-channel/articles/publication';
import { z } from 'zod';
import type { ArticleDatabase } from './article-repository.ts';

function rows(input: unknown) {
  const result = z
    .object({
      data: z.array(z.record(z.unknown())).max(100),
      code: z.union([z.literal(0), z.literal('')]).optional(),
    })
    .passthrough()
    .parse(input);
  return result.data;
}
/** Caller must hold the delivery lock for the entire read/build/delivery/acceptance. */
export async function readAcceptedArticles(db: ArticleDatabase) {
  const articles = [];
  let after = '';
  for (let page = 0; page <= 10; page++) {
    let query = db.collection('articleAccepted').orderBy('_id', 'asc').limit(100);
    if (after) query = query.where({ _id: db.command.gt(after) });
    const data = rows(await query.get());
    for (const raw of data) {
      const value = z
        .object({ _id: articleIdentity, taskId: articleIdentity, publication: z.unknown() })
        .strict()
        .parse(raw);
      if (value._id <= after) throw new Error('Article accepted pagination did not advance');
      after = value._id;
      if (value.publication !== null) {
        const article = parsePublishedArticle(value.publication);
        if (article.articleId !== value._id) throw new Error('Article accepted identity mismatch');
        articles.push(article);
      }
      if (articles.length > 1000) throw new Error('Article build inventory limit exceeded');
    }
    if (data.length < 100) return articles;
  }
  throw new Error('Article accepted inventory scan limit exceeded');
}
