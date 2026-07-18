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
