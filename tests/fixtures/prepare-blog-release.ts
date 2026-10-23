import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publishedArticleFixture } from '../../apps/site/src/lib/blog/testing.ts';
const directory = process.argv[2];
if (!directory) throw new Error('Owned fixture output required');
const accepted = publishedArticleFixture();
const { status: _status, deliveryId: _deliveryId, acceptedAt: _acceptedAt, ...data } = accepted;
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'release.json'), JSON.stringify({ siteOrigin: 'http://localhost:4321', release: { schemaVersion: 1, purpose: 'article-release', taskId: 'task-one', articleId: data.articleId, revision: data.revision, operation: 'publish', accepted: [], candidate: { ...data, taskId: 'task-one', status: 'candidate' } } }));
