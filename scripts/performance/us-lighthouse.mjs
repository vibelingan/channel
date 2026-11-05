import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
const profile = process.argv[2];
if (!['mobile', 'desktop'].includes(profile)) throw Error('Explicit profile required');
const directory = `performance-evidence/${profile}`;
await mkdir(directory, { recursive: true });
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
await writeFile(
  `${directory}/conditions.json`,
  JSON.stringify(
    {
      phase: 'before',
      checkedAt: new Date().toISOString(),
      profile,
      egressCountry: trace.loc,
      colo: trace.colo,
      locationEvidence: 'Cloudflare trace loc for hosted runner; not GPS simulation',
      node: process.version,
      lighthouse: '13.0.1',
      repeats: 3,
      fieldInp: null,
    },
    null,
    2,
  ),
);
if (trace.loc !== 'US') throw Error('Runner not verified in US; do not label results US');
const urls = [
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
let failures = 0;
for (let index = 0; index < urls.length; index++)
  for (let repeat = 1; repeat <= 3; repeat++) {
    const args = [
      process.env.LIGHTHOUSE_CLI,
      `https://supplychainsai.com${urls[index]}`,
      '--only-categories=performance',
      '--output=json',
      `--output-path=${directory}/${index}-${repeat}.json`,
      '--chrome-flags=--headless --no-sandbox --disable-dev-shm-usage',
      '--quiet',
    ];
    if (profile === 'desktop') args.push('--preset=desktop');
    const result = spawnSync(process.execPath, args, {
      stdio: 'inherit',
      timeout: 120000,
      env: process.env,
    });
    if (result.status !== 0) failures++;
    console.log(
      JSON.stringify({
        index,
        repeat,
        profile,
        status: result.status,
        error: result.error?.code ?? null,
      }),
    );
  }
if (failures) throw Error(`${failures} audit samples failed; retain evidence`);
