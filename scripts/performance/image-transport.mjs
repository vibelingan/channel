import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const api = 'https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com';
const site = 'https://supplychainsai.com';
const images = [
  {
    path: '/api/images/3fbe8b166ac87f63003984d22ff5a5d7',
    bytes: 51178,
    sha256: '8e5b2780aaeb7d0fa3101bd275079c10297ca20d60291f9d44879452aff5c794',
    mime: 'image/webp',
  },
  {
    path: '/api/images/96d9cd126ac88460006e1c2f6fe3d0a4?w=640',
    bytes: 16116,
    sha256: 'bb375aff0b629d2b71eb3448cce5ee32de71c93e03fa16759c20e7a5dacfc474',
    mime: 'image/webp',
  },
];
export const transportTargets = [
  ...images.flatMap(({ path, ...expected }) =>
    [site, api].map((origin) => ({ url: origin + path, ...expected })),
  ),
  {
    url: `${site}/_astro/BaseLayout.mfjaJzIa.css`,
    bytes: 102058,
    sha256: 'b04b96284738a39dafa6692d067de0f40872510238cf9476b2a606b730bdbc3c',
    mime: 'text/css',
  },
];

/** One cold connection, no redirects or retries; success requires the complete expected file. */
export async function measureTransfer(target, timeoutSeconds = 20) {
  const directory = await mkdtemp(join(tmpdir(), 'channel-image-transport-'));
  try {
    const bodyFile = join(directory, 'body');
    const { stdout } = await run(
      'curl',
      [
        '--disable',
        '--silent',
        '--show-error',
        '--compressed',
        '--connect-timeout',
        String(Math.min(10, timeoutSeconds)),
        '--max-time',
        String(timeoutSeconds),
        '--max-filesize',
        '3100000',
        '--output',
        bodyFile,
        '--write-out',
        '%{json}\n%{header_json}',
        target.url,
      ],
      { timeout: Math.ceil(timeoutSeconds * 1000) + 2000, maxBuffer: 512 * 1024 },
    );
    const boundary = stdout.indexOf('\n');
    const stats = JSON.parse(stdout.slice(0, boundary));
    const rawHeaders = JSON.parse(stdout.slice(boundary + 1));
    const bytes = await readFile(bodyFile);
    const header = (key) => rawHeaders[key]?.at(-1) ?? null;
    assert.equal(stats.response_code ?? stats.http_code, 200, 'Public file did not return 200');
    assert.equal(stats.num_redirects, 0, 'A different resource cannot replace the planned target');
    assert.equal(header('content-type')?.split(';')[0], target.mime, 'Unexpected MIME');
    assert.equal(bytes.byteLength, target.bytes, 'Incomplete or changed file');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), target.sha256, 'File changed');
    const times = Object.fromEntries(
      ['namelookup', 'connect', 'appconnect', 'pretransfer', 'starttransfer', 'total'].map(
        (name) => {
          const value = stats[`time_${name}`];
          assert(typeof value === 'number' && Number.isFinite(value) && value >= 0);
          return [name, value * 1000];
        },
      ),
    );
    assert(times.connect >= times.namelookup && times.total >= times.starttransfer);
    const upstream = header('x-cloudbase-upstream-timecost');
    const upstreamMs = /^\d+(?:\.\d+)?$/.test(upstream ?? '') ? Number(upstream) : null;
    const headers = Object.fromEntries(
      [
        'cache-control',
        'content-encoding',
        'age',
        'via',
        'x-cache',
        'server-timing',
        'x-cloudbase-request-id',
        'x-cloudbase-upstream-type',
      ].map((key) => [key, header(key)]),
    );
    return {
      url: target.url,
      status: 200,
      bytes: bytes.byteLength,
      sha256: target.sha256,
      protocol: stats.http_version,
      connections: stats.num_connects,
      networkPayloadBytes: stats.size_download,
      times,
      afterFirstByteMs: times.total - times.starttransfer,
      upstreamMs: upstreamMs !== null && upstreamMs <= 120000 ? upstreamMs : null,
      headers,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function publicVersion() {
  const response = await fetch(`${api}/api/health`, { signal: AbortSignal.timeout(20000) });
  const health = await response.json();
  assert(response.ok && health.ok && health.data?.service === 'public-api');
  assert(/^[a-f0-9]{40}$/.test(health.data.releaseId ?? ''));
  return health.data.releaseId;
}

async function pageIdentity() {
  const response = await fetch(site, { signal: AbortSignal.timeout(20000) });
  const body = Buffer.from(await response.arrayBuffer());
  assert(
    response.ok && body.toString('utf8').includes('/_astro/BaseLayout.mfjaJzIa.css'),
    'The measured stylesheet is not in the current page',
  );
  return createHash('sha256').update(body).digest('hex');
}

async function main() {
  const [phase, ...extra] = process.argv.slice(2);
  assert(['before', 'after'].includes(phase) && extra.length === 0, 'Explicit phase required');
  assert(/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? ''), 'Explicit workflow source required');
  const directory = 'performance-evidence/transport';
  await mkdir(directory, { recursive: true });
  const result = {
    sourceSha: process.env.GITHUB_SHA,
    phase,
    checkedAt: new Date().toISOString(),
    writes: 0,
    repeats: 3,
    requestBudget: 20,
    samples: [],
    conditions:
      'Separate curl processes; cold connections, no browser/CPU/network simulation, no automatic retries',
    egressCountry: null,
    colo: null,
    publicApiBefore: null,
    publicApiAfter: null,
    htmlBefore: null,
    htmlAfter: null,
  };
  const save = () => writeFile(`${directory}/result.json`, JSON.stringify(result, null, 2));
  await save();
  const location = await fetch('https://www.cloudflare.com/cdn-cgi/trace', {
    signal: AbortSignal.timeout(20000),
  });
  assert(location.ok, 'Egress lookup failed');
  const trace = Object.fromEntries(
    (await location.text())
      .trim()
      .split('\n')
      .map((x) => x.split('=')),
  );
  result.egressCountry = trace.loc;
  result.colo = trace.colo;
  await save();
  assert.equal(trace.loc, 'US', 'Do not label non-US measurements as US');
  result.publicApiBefore = await publicVersion();
  result.htmlBefore = await pageIdentity();
  result.curl = (await run('curl', ['--disable', '--version'])).stdout.split('\n')[0];
  for (let repeat = 1; repeat <= 3; repeat++)
    for (const target of transportTargets) {
      try {
        result.samples.push({ repeat, ...(await measureTransfer(target)) });
      } catch (error) {
        result.samples.push({
          repeat,
          url: target.url,
          status: 'failed',
          error:
            error.code === 'ERR_ASSERTION'
              ? 'RESPONSE_MISMATCH'
              : String(error.code ?? 'READ_FAILED'),
        });
      }
      await save();
    }
  result.publicApiAfter = await publicVersion();
  result.htmlAfter = await pageIdentity();
  await save();
  assert.equal(
    result.publicApiBefore,
    result.publicApiAfter,
    'Public API changed during measurement',
  );
  assert.equal(result.htmlBefore, result.htmlAfter, 'Current page changed during measurement');
  assert.equal(
    result.samples.filter((x) => x.status === 'failed').length,
    0,
    'Retain failed samples',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
