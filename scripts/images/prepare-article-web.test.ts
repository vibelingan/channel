import assert from 'node:assert/strict';
import test from 'node:test';
import { runArticleWebPreparation } from './prepare-article-web.ts';

test('the real preparation entry rejects unconfirmed or foreign plans before SDK calls', async () => {
  const previous = process.env.ARTICLE_WEB_MEDIA_CONFIRM;
  const input = {
    config: { secretId: 'fixture', secretKey: 'never-a-live-credential' },
    plan: {
      envId: 'diversity-123-d9grnqfux221323bb',
      region: 'ap-shanghai',
      articleId: 'fixture-article',
      media: [{ id: 'fixture-image', sha256: 'a'.repeat(64) }],
    },
    outputDirectory: 'output/article-web-must-not-start',
  };
  try {
    process.env.ARTICLE_WEB_MEDIA_CONFIRM = 'not-confirmed';
    await assert.rejects(runArticleWebPreparation(input), /confirmation/);
    process.env.ARTICLE_WEB_MEDIA_CONFIRM = 'PREPARE_SELECTED_ONLY';
    for (const plan of [
      { ...input.plan, envId: 'another-environment' },
      { ...input.plan, region: 'another-region' },
      { ...input.plan, media: [...input.plan.media, ...input.plan.media] },
    ])
      await assert.rejects(runArticleWebPreparation({ ...input, plan }));
    await assert.rejects(
      runArticleWebPreparation({
        ...input,
        config: { ...input.config, envId: 'another-environment' },
      }),
    );
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'ARTICLE_WEB_MEDIA_CONFIRM');
    else process.env.ARTICLE_WEB_MEDIA_CONFIRM = previous;
  }
});
