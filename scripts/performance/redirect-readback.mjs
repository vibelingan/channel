import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fetchFully } from '../smoke-http.mjs';

const [output, mode] = process.argv.slice(2);
if (!output || (mode !== undefined && mode !== '--require-apex-301') || process.argv.length > 4)
  throw Error('Usage: node scripts/performance/redirect-readback.mjs OUTPUT [--require-apex-301]');

const canonical = 'https://supplychainsai.com';
const origins = [
  'http://supplychainsai.com',
  canonical,
  'http://www.supplychainsai.com',
  'https://www.supplychainsai.com',
];
const missingPath = '/__channel_seo_missing__/';
const paths = [
  '/?seo_probe=one%20two&keep=1',
  '/headphones/?page=2',
  '/blog/?seo_probe=1',
  missingPath,
];
const methods = mode ? ['GET', 'HEAD'] : ['GET'];

async function probe(method, origin, path) {
  const url = origin + path;
  try {
    const response = await fetchFully(method, url, {
      timeoutMs: 20000,
      maxBytes: 2097152,
      redirect: 'manual',
    });
    return {
      ...(mode ? { method } : {}),
      url,
      status: response.status,
      location: response.headers.get('location'),
      sha256: createHash('sha256').update(response.body).digest('hex'),
    };
  } catch (error) {
    return { ...(mode ? { method } : {}), url, error: error.code ?? error.name };
  }
}

const results = [];
const failures = [];
for (const origin of origins) {
  for (const path of paths) {
    for (const method of methods) {
      const result = await probe(method, origin, path);
      results.push(result);
      if (!mode) continue;
      const expectedStatus = origin === canonical ? (path === missingPath ? 404 : 200) : 301;
      const expectedLocation = origin === canonical ? null : canonical + path;
      if (result.status !== expectedStatus || result.location !== expectedLocation)
        failures.push({ ...result, expectedStatus, expectedLocation });
    }
  }
}
const evidence = {
  checkedAt: new Date().toISOString(),
  businessWrites: 0,
  results,
  ...(mode ? { acceptance: { passed: failures.length === 0, failures } } : {}),
};
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
if (mode) console.log(JSON.stringify(evidence.acceptance));
else console.log(JSON.stringify(results));
if (failures.length) process.exitCode = 1;
