import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fetchFully } from '../smoke-http.mjs';
const output = process.argv[2];
if (!output) throw Error('Evidence output file required');
const results = [];
for (const origin of [
  'http://supplychainsai.com',
  'https://supplychainsai.com',
  'http://www.supplychainsai.com',
  'https://www.supplychainsai.com',
]) {
  for (const path of [
    '/?seo_probe=one%20two&keep=1',
    '/headphones/?page=2',
    '/blog/?seo_probe=1',
    '/__channel_seo_missing__/',
  ]) {
    try {
      const response = await fetchFully('GET', origin + path, {
        timeoutMs: 20000,
        maxBytes: 2097152,
        redirect: 'manual',
      });
      results.push({
        url: origin + path,
        status: response.status,
        location: response.headers.get('location'),
        sha256: createHash('sha256').update(response.body).digest('hex'),
      });
    } catch (error) {
      results.push({ url: origin + path, error: error.code ?? error.name });
    }
  }
}
await writeFile(
  output,
  `${JSON.stringify({ checkedAt: new Date().toISOString(), businessWrites: 0, results }, null, 2)}\n`,
);
console.log(JSON.stringify(results));
