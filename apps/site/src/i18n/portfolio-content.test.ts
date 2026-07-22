import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const portfolioContent = readFileSync(
  fileURLToPath(new URL('./content/portfolio/en-US.md', import.meta.url)),
  'utf8',
);
const portfolioTypes = readFileSync(
  fileURLToPath(new URL('./portfolio.ts', import.meta.url)),
  'utf8',
);
const showcaseSource = readFileSync(
  fileURLToPath(new URL('../components/CaseShowcase.astro', import.meta.url)),
  'utf8',
);
const portfolioPage = readFileSync(
  fileURLToPath(new URL('../pages/portfolio.astro', import.meta.url)),
  'utf8',
);
const siteContent = readFileSync(
  fileURLToPath(new URL('./content/en-US.md', import.meta.url)),
  'utf8',
);
const deployScript = readFileSync(
  fileURLToPath(new URL('../../../../scripts/deploy-cloudbase-test.mjs', import.meta.url)),
  'utf8',
);
const deploySmoke = readFileSync(
  fileURLToPath(new URL('../../../../scripts/smoke-cloudbase-deploy.mjs', import.meta.url)),
  'utf8',
);
const astroConfig = readFileSync(
  fileURLToPath(new URL('../../astro.config.ts', import.meta.url)),
  'utf8',
);
const envExample = readFileSync(
  fileURLToPath(new URL('../../../../.env.example', import.meta.url)),
  'utf8',
);
const deployWorkflow = readFileSync(
  fileURLToPath(new URL('../../../../.github/workflows/deploy-test.yml', import.meta.url)),
  'utf8',
);
const deploymentGuide = readFileSync(
  fileURLToPath(new URL('../../../../docs/CLOUDBASE_DEPLOYMENT_EXECUTION.md', import.meta.url)),
  'utf8',
);
const retiredPortfolioPaths = [
  '../components/CaseStudyCard.astro',
  '../data/successStories.ts',
  '../../public/media/portfolio/cases/tws-speaker-1.webp',
];

test('portfolio defines audited cumulative stats independent of visible item counts', () => {
  assert.ok(portfolioTypes.includes('stats: { items: PortfolioStat[]; note: string };'));
  const statsBlock = portfolioContent.match(/^stats:\n([\s\S]*?)^customers:/m);
  assert.ok(statsBlock, 'portfolio cumulative stats exist');
  assert.deepEqual(
    [...statsBlock[1].matchAll(/- \{ value: '([^']+)', label: ([^}]+) \}/g)].map((match) => ({
      value: match[1],
      label: match[2].trim(),
    })),
    [
      { value: '50+', label: 'Case Studies' },
      { value: '30+', label: 'Trusted Clients' },
      { value: '100+', label: 'Certifications' },
    ],
  );
  assert.ok(statsBlock[1].includes('company-wide cumulative totals'));
  assert.ok(portfolioPage.includes('const { meta, hero, stats, customers, cases, certificates }'));
  assert.ok(portfolioPage.includes('data-portfolio-stats'));
  assert.ok(portfolioPage.includes('stats.items.map'));
  assert.ok(portfolioPage.includes('{stat.value}'));
  assert.ok(portfolioPage.includes('{stat.label}'));
  assert.ok(portfolioPage.includes('{stats.note}'));
  assert.equal((siteContent.match(/label: Success Stories, href: '\/portfolio'/g) ?? []).length, 2);
  assert.ok(!siteContent.includes("label: Success Stories, href: '/success-stories'"));
});

test('portfolio uses the two confirmed image-backed cases in vertical order', () => {
  const casesBlock = portfolioContent.match(/^cases:\n([\s\S]*?)^certificates:/m);
  assert.ok(casesBlock, 'portfolio case content exists');
  const titles = [...casesBlock[1].matchAll(/^ {4}- title: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(titles, ["Children's Sleep Training Clock", 'Disc Repair System']);
  assert.ok(!casesBlock[1].includes('Character TWS Bluetooth Speaker'));
  assert.ok(!casesBlock[1].includes('tws-speaker'));

  const images = [...casesBlock[1].matchAll(/^ {6}image: (\/media\/\S+)$/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(images, [
    '/media/portfolio/cases/sleep-clock.webp',
    '/media/portfolio/cases/disc-repair.jpg',
  ]);
  assert.equal(new Set(images).size, 2);
  for (const image of images) {
    const file = fileURLToPath(new URL(`../../public${image}`, import.meta.url));
    assert.ok(existsSync(file), `case image exists: ${image}`);
  }

  const normalized = casesBlock[1].replace(/\s+/g, ' ');
  for (const copy of [
    'A leading children’s brand',
    'Consumer Goods',
    'Complete OEM development of a sleep-training clock combining visual wake-up indicators, projection lighting, alarm functions, and a nightlight in a child-friendly design.',
    'Precision Products Client',
    '3C Electronics',
    'Precision mechanical product manufacturing featuring a patented manual disc-repair mechanism designed to restore scratched CDs, DVDs, and gaming discs through a carefully engineered resurfacing process.',
  ]) {
    assert.ok(normalized.includes(copy), `missing confirmed case copy: ${copy}`);
  }
});

test('CaseShowcase renders full-width alternating product stories without cropping images', () => {
  for (const field of ['client:', 'category:', 'summary:', 'imageWidth:', 'imageHeight:']) {
    assert.ok(portfolioTypes.includes(field), `StarCase includes ${field}`);
  }
  assert.ok(showcaseSource.includes('{c.client}'));
  assert.ok(showcaseSource.includes('{c.category}'));
  assert.ok(showcaseSource.includes('{c.summary}'));
  assert.ok(showcaseSource.includes('width={c.imageWidth}'));
  assert.ok(showcaseSource.includes('height={c.imageHeight}'));
  assert.ok(showcaseSource.includes('object-contain'));
  assert.ok(!showcaseSource.includes('object-cover'));
  assert.ok(showcaseSource.includes("i % 2 === 1 && 'lg:order-2'"));
  assert.ok(showcaseSource.includes("i % 2 === 1 && 'lg:order-1'"));
  assert.ok(showcaseSource.includes('space-y-16'));
});

test('portfolio classifies every supplied certificate and patent accurately', () => {
  assert.ok(portfolioTypes.includes("kind: 'compliance' | 'design-patent' | 'patent-record'"));
  const certificatesBlock = portfolioContent.match(/^certificates:\n([\s\S]*?)^---$/m);
  assert.ok(certificatesBlock, 'portfolio certificate content exists');
  assert.ok(certificatesBlock[1].includes('complianceLabel: Compliance & Testing'));
  assert.ok(certificatesBlock[1].includes('designPatentLabel: Design Patents'));
  assert.ok(certificatesBlock[1].includes('patentRecordLabel: Patent Record'));

  const normalized = certificatesBlock[1].replace(/\s+/g, ' ');
  for (const contract of [
    "label: 'CE Certificate of Compliance — AS1 Bluetooth Speaker', kind: compliance",
    "label: 'EMC Test Report — Kids Headphone KH4', kind: compliance",
    "label: 'FCC Test Report — Headphone KH1', kind: compliance",
    "label: 'JD Test Report — TS1 Bluetooth Headphone', kind: compliance",
    "label: 'AS1 Speaker — Design Patent', kind: design-patent",
    "label: 'CS1 Speaker — Design Patent', kind: design-patent",
    "label: 'SC3 Headphone — Design Patent', kind: design-patent",
    "label: 'A701 Gaming Headset — Patent Record', kind: patent-record",
  ]) {
    assert.ok(normalized.includes(contract), `missing accurate certificate contract: ${contract}`);
  }
  assert.ok(!normalized.includes('product test report'));
});

test('superseded Success Stories code and TWS asset are removed', () => {
  for (const relativePath of retiredPortfolioPaths) {
    assert.ok(
      !existsSync(fileURLToPath(new URL(relativePath, import.meta.url))),
      `retired portfolio path removed: ${relativePath}`,
    );
  }
  assert.ok(portfolioTypes.includes('export interface StarCase'));
  assert.ok(portfolioContent.includes('Disc Repair System'));
  assert.ok(!portfolioContent.includes('Character TWS Bluetooth Speaker'));
  assert.ok(
    deployScript.includes(
      "{ cloudPath: 'media/portfolio/cases/tws-speaker-1.webp', isDir: false }",
    ),
    'retired TWS asset is pruned from additive hosting',
  );
  assert.ok(
    deployScript.includes(
      'assertToolSucceeded(uploaded, `${webAppServiceName}: static hosting upload`)',
    ),
    'hosting upload failures block deployment',
  );
  for (const mediaPath of [
    '/media/portfolio/cases/sleep-clock.webp',
    '/media/portfolio/cases/disc-repair.jpg',
    '/media/portfolio/cases/tws-speaker-1.webp',
  ]) {
    assert.ok(deploySmoke.includes(mediaPath), `deploy smoke covers portfolio media: ${mediaPath}`);
  }
  assert.match(
    deploySmoke,
    /tws-speaker-1\.webp[\s\S]*?encodeURIComponent\(expectedReleaseId\)[\s\S]*?404/,
    'retired TWS media must return 404 after deployment',
  );
});

test('portfolio canonical origin comes from the build-time SITE_URL contract', () => {
  assert.ok(astroConfig.includes("env.SITE_URL?.trim() || 'http://localhost:4321'"));
  assert.ok(!astroConfig.includes('channel.example.com'));
  assert.ok(envExample.includes('SITE_URL=http://localhost:4321'));
  assert.ok(deployWorkflow.includes('SITE_URL: ${{ vars.SITE_URL'));
  assert.ok(deployWorkflow.includes('E2E_SITE_URL: ${{ vars.SITE_URL'));
  assert.ok(deploymentGuide.includes('gh variable set SITE_URL --env test'));
  assert.ok(
    deploymentGuide.includes(
      'SITE_URL=https://<site-url> PUBLIC_CB_PROXY=0 PUBLIC_API_BASE_URL=https://<api-origin> pnpm build',
    ),
  );
});
