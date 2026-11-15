import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const lighthouseVersion = '13.0.1';
const paths = [
  '/',
  '/headphones/',
  '/oem/',
  '/portfolio/',
  '/products/p-003a6310-5244-4766-adfa-eb1002ad0fb4/',
  '/products/p-804ee5b9-209c-41b7-ae91-9c854fc8d1b4/',
  '/products/p-ffc81bae-b098-4d3d-a7e5-ed539db80a1e/',
  '/blog/',
  '/blog/oem-headphone-sample-inspection-wecom-20261027/',
];

export function measurementPlan(args) {
  const [profile, phase = 'before', scope = 'all', ...extra] = args;
  if (!['mobile', 'desktop'].includes(profile)) throw Error('Explicit profile required');
  if (!['before', 'after'].includes(phase)) throw Error('Phase must be before or after');
  if (!['all', 'image-pages'].includes(scope)) throw Error('Scope must be all or image-pages');
  if (extra.length) throw Error('Unexpected measurement parameters');
  return {
    profile,
    phase,
    scope,
    repeats: 3,
    pages: paths
      .map((path, index) => ({ index, url: `https://supplychainsai.com${path}` }))
      .filter(({ index }) => scope === 'all' || [4, 5, 6, 8].includes(index)),
  };
}

export function sampleMetadata(report, requestedUrl) {
  // Performance-only Lighthouse 13 reports expose HTTP status in network-requests.
  const requests = report?.audits?.['network-requests']?.details?.items;
  if (
    !report ||
    report.lighthouseVersion !== lighthouseVersion ||
    report.requestedUrl !== requestedUrl ||
    report.finalUrl !== requestedUrl ||
    !Array.isArray(requests) ||
    !requests.some(
      (item) =>
        item?.resourceType === 'Document' && item.url === requestedUrl && item.statusCode === 200,
    ) ||
    report.runtimeError ||
    !Number.isFinite(report.audits?.['largest-contentful-paint']?.numericValue)
  )
    throw Error('Lighthouse report identity or measurement is invalid');
  const userAgent = report.environment?.hostUserAgent;
  return {
    finalUrl: report.finalUrl,
    chromeVersion:
      typeof userAgent === 'string'
        ? (/(?:HeadlessChrome|Chrome)\/([0-9.]+)/.exec(userAgent)?.[1] ?? null)
        : null,
  };
}

async function main() {
  const { profile, phase, scope, repeats, pages } = measurementPlan(process.argv.slice(2));
  const directory = `performance-evidence/${profile}`;
  await mkdir(directory, { recursive: true });
  const sourceSha =
    process.env.GITHUB_SHA ??
    spawnSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
    }).stdout?.trim();
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '')) throw Error('Verified source SHA required');
  const conditions = {
    phase,
    scope,
    checkedAt: new Date().toISOString(),
    profile,
    sourceSha,
    urls: pages,
    egressCountry: null,
    colo: null,
    locationEvidence: 'Cloudflare trace loc for hosted runner; not GPS simulation',
    node: process.version,
    lighthouse: lighthouseVersion,
    chromeVersions: [],
    chromeVersionEvidence: 'Lighthouse environment.hostUserAgent; unknown until a report completes',
    repeats,
    fieldInp: null,
  };
  const saveConditions = () =>
    writeFile(`${directory}/conditions.json`, JSON.stringify(conditions, null, 2));
  await saveConditions();
  const response = await fetch('https://www.cloudflare.com/cdn-cgi/trace', {
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error('Egress lookup failed');
  const trace = Object.fromEntries(
    (await response.text())
      .trim()
      .split('\n')
      .map((line) => line.split('=')),
  );
  conditions.egressCountry = trace.loc;
  conditions.colo = trace.colo;
  await saveConditions();
  if (trace.loc !== 'US') throw Error('Runner not verified in US; do not label results US');
  let failures = 0;
  const samples = [];
  for (const { index, url } of pages)
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const outputPath = `${directory}/${index}-${repeat}.json`;
      const args = [
        process.env.LIGHTHOUSE_CLI,
        url,
        '--only-categories=performance',
        '--output=json',
        `--output-path=${outputPath}`,
        '--chrome-flags=--headless --no-sandbox --disable-dev-shm-usage',
        '--quiet',
      ];
      if (profile === 'desktop') args.push('--preset=desktop');
      const result = spawnSync(process.execPath, args, {
        stdio: 'inherit',
        timeout: 120000,
        env: process.env,
      });
      const sample = {
        index,
        url,
        repeat,
        profile,
        phase,
        scope,
        status: result.status,
        error: result.error?.code ?? null,
        finalUrl: null,
        chromeVersion: null,
      };
      if (result.status !== 0) failures++;
      else {
        try {
          Object.assign(
            sample,
            sampleMetadata(JSON.parse(await readFile(outputPath, 'utf8')), url),
          );
          if (sample.chromeVersion && !conditions.chromeVersions.includes(sample.chromeVersion))
            conditions.chromeVersions.push(sample.chromeVersion);
        } catch {
          sample.error = 'INVALID_LIGHTHOUSE_REPORT';
          failures++;
        }
      }
      samples.push(sample);
      await writeFile(`${directory}/samples.json`, JSON.stringify(samples, null, 2));
      await saveConditions();
      console.log(JSON.stringify(sample));
    }
  if (failures) throw Error(`${failures} audit samples failed; retain evidence`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
