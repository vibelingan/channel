import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { orderPrimaryNavItems } from '../lib/site-navigation.ts';

// Source-of-truth markdown (the i18n loader needs Vite's import.meta.glob, which
// isn't available under `tsx --test`), so we assert the brand config directly.
const enUS = readFileSync(fileURLToPath(new URL('./content/en-US.md', import.meta.url)), 'utf8');
const headerSource = readFileSync(
  fileURLToPath(new URL('../components/SiteHeader.astro', import.meta.url)),
  'utf8',
);
const heroSource = readFileSync(
  fileURLToPath(new URL('../components/AIHero.astro', import.meta.url)),
  'utf8',
);
const siteTypeSource = readFileSync(fileURLToPath(new URL('./site.ts', import.meta.url)), 'utf8');
const servicesSource = readFileSync(
  fileURLToPath(new URL('../components/ServiceGridSection.astro', import.meta.url)),
  'utf8',
);
const oemPageSource = readFileSync(
  fileURLToPath(new URL('../pages/oem.astro', import.meta.url)),
  'utf8',
);
const homepageSource = readFileSync(
  fileURLToPath(new URL('../pages/index.astro', import.meta.url)),
  'utf8',
);

test('brand.logo points to the configured client logo', () => {
  const match = enUS.match(/^\s*logo:\s*(\S+)\s*$/m);
  assert.ok(match, 'brand.logo is defined');
  assert.equal(match[1], '/media/logo-channel.svg');
});

test('the referenced brand logo asset exists in public/media', () => {
  const asset = fileURLToPath(new URL('../../public/media/logo-channel.svg', import.meta.url));
  assert.ok(existsSync(asset), 'logo-channel.svg present in public/media');
});

test('logo-channel.svg is the approved historical CHANNEL wordmark', () => {
  const asset = readFileSync(
    fileURLToPath(new URL('../../public/media/logo-channel.svg', import.meta.url)),
    'utf8',
  );
  assert.match(asset, /width="226"/);
  assert.match(asset, /height="30"/);
  assert.match(asset, /viewBox="0 0 226 30"/);
  assert.match(asset, /#153687/i, 'CHANNEL navy is present');
  assert.match(asset, /#ff5f00/i, 'CHANNEL orange accent is present');
  assert.ok(!asset.includes('#ef802e'), 'Diversity Innovations orange is absent');
  assert.equal((asset.match(/<path\b/g) ?? []).length, 2, 'historical two-path wordmark');
});

test('site header renders only the CHANNEL wordmark and prioritizes OEM Development', () => {
  assert.equal(
    headerSource.match(/\{brand\.name\}/g)?.length,
    1,
    'company name is present only as accessible logo text',
  );
  assert.ok(headerSource.includes('alt={brand.name}'), 'logo keeps accessible company text');
  assert.ok(!headerSource.includes('{brand.minOrder}'), 'header does not render the MOQ badge');
  assert.ok(
    headerSource.includes('orderedMenuItems.map'),
    'desktop and mobile menus consume OEM-first items',
  );
  assert.ok(
    headerSource.includes('border-b-2 border-brand-700'),
    'header uses the approved brand-blue lower border',
  );
});

test('OEM navigation remains first when its final URL includes the What We Do fragment', () => {
  const ordered = orderPrimaryNavItems([
    { label: 'Success Stories', href: '/portfolio' },
    { label: 'Teardown Lab', href: '/teardown-lab' },
    { label: 'OEM Development', href: '/oem#what-we-do' },
    { label: 'Blue Ocean', href: '/blue-ocean' },
  ]);

  assert.deepEqual(
    ordered.map((item) => item.href),
    ['/oem#what-we-do', '/portfolio', '/teardown-lab', '/blue-ocean'],
  );
});

test('homepage hero fills the viewport below the fixed header without changing its visual layers', () => {
  assert.ok(
    heroSource.includes('min-h-[calc(100svh-var(--spacing-header))]'),
    'hero reserves the viewport height below the fixed header',
  );
  assert.ok(heroSource.includes('bg-surface-dark'), 'existing dark background remains');
  assert.ok(heroSource.includes('background-size: 60px 60px'), 'existing grid remains');
  assert.ok(heroSource.includes('bg-brand-500/30'), 'existing left glow remains');
  assert.ok(heroSource.includes('bg-accent-500/20'), 'existing right glow remains');
});

test('site content defines the exact shared Traditional-versus-AI What We Do contract', () => {
  assert.ok(siteTypeSource.includes('export interface WorkflowComparison'));
  assert.ok(siteTypeSource.includes('workflows: WorkflowComparison[]'));

  const servicesBlock = enUS.match(/^services:\n([\s\S]*?)^oemProcess:/m);
  assert.ok(servicesBlock, 'shared What We Do content exists');
  const workflowBlocks = servicesBlock[1].split(/^ {4}- mode: /m).slice(1);
  assert.equal(workflowBlocks.length, 2, 'exactly two comparison workflows');
  const [traditionalWorkflow, aiWorkflow] = workflowBlocks;
  assert.ok(traditionalWorkflow.startsWith('traditional\n'));
  assert.ok(aiWorkflow.startsWith('ai\n'));

  const workflowStepLines = (workflow: string): string[] =>
    workflow.match(/^ {8}- \{ label:.*$/gm) ?? [];

  assert.deepEqual(workflowStepLines(traditionalWorkflow), [
    '        - { label: Client Full Drawings & Complete Requirements }',
    '        - { label: Manual Feasibility Check }',
    '        - { label: Manual ID & Engineering Design }',
    '        - { label: Multiple Rounds Physical Sampling & Validation }',
    '        - { label: Post-Sample Tooling & Fixture Making }',
    '        - { label: Mass Production + Manual QC }',
    '        - { label: Final Global Shipping }',
  ]);
  assert.deepEqual(workflowStepLines(aiWorkflow), [
    '        - { label: Client Simple Rough Ideas / Basic Sketches }',
    "        - { label: 'AI Big Data: Active Market Insight + Auto Feasibility Analysis + Multiple Concept Proposals' }",
    "        - { label: 'AI Auto Design & Engineering + Instant Material Database Matching + Upfront Cost Pre-Estimation', highlight: true }",
    "        - { label: 'AI Virtual Simulation Pre-Prototype (Minimize Physical Samples)' }",
    "        - { label: 'Advanced Accurate Tooling & Full Production Cost Evaluation', highlight: true }",
    "        - { label: 'Optimized Mass Production + AI Pre-QC Risk Control' }",
    "        - { label: 'Synchronized Global Logistics & Fast Delivery' }",
  ]);
  assert.equal([...traditionalWorkflow.matchAll(/highlight:\s*true/g)].length, 0);
  assert.equal([...aiWorkflow.matchAll(/highlight:\s*true/g)].length, 2);

  const requiredCopy = [
    'AI-Powered Product Development & Fast OEM Delivery',
    'From AI market insights and intelligent cost estimation to rapid prototyping and mass production, we help brands develop smarter products and launch them faster.',
    'Traditional Drawing-Based OEM Workflow',
    'Client Full Drawings & Complete Requirements',
    'Pain Points: Passive service, long lead time, repeated rework, delayed cost assessment',
    'AI Big Data Smart OEM Workflow',
    'Instant Material Database Matching + Upfront Cost Pre-Estimation',
    'Advanced Accurate Tooling & Full Production Cost Evaluation',
    'Core Advantages: Proactive front-end service, shorter development cycle, fewer revisions, predictable & controllable costs',
  ];
  for (const copy of requiredCopy) {
    assert.ok(enUS.includes(copy), `missing confirmed What We Do copy: ${copy}`);
  }

  assert.ok(enUS.includes("href: '/oem#what-we-do'"), 'OEM nav targets the shared section');
  assert.equal(
    [...enUS.matchAll(/highlight:\s*true/g)].length,
    2,
    'both AI quotation/cost-evaluation steps are highlighted',
  );
});

test('shared What We Do component renders semantic workflows and highlighted cost steps', () => {
  assert.ok(servicesSource.includes('services.workflows.map'));
  assert.ok(servicesSource.includes('data-workflow-mode={workflow.mode}'));
  assert.ok(servicesSource.includes('<ol'));
  assert.ok(servicesSource.includes('step.highlight'));
  assert.ok(servicesSource.includes('AI quotation & cost intelligence'));
  assert.ok(servicesSource.includes('{workflow.takeaway}'));
  assert.ok(!servicesSource.includes('takeawayBody('));
  assert.ok(
    servicesSource.includes('aria-label={workflow.takeawayLabel}'),
    'takeaway label names the footer without duplicating the verbatim sentence',
  );
  assert.equal(servicesSource.match(/\{workflow\.takeawayLabel\}/g)?.length, 1);
});

test('homepage retains the separate 10-step OEM execution process', () => {
  const processBlock = enUS.match(/^oemProcess:\n([\s\S]*?)^factory:/m);
  assert.ok(processBlock, 'homepage OEM process content exists');
  assert.equal(
    [...processBlock[1].matchAll(/^ {4}- label:/gm)].length,
    10,
    'homepage OEM execution process keeps all 10 steps',
  );
  assert.ok(homepageSource.includes('<OemProcessSection process={oemProcess} />'));
});

test('OEM page reuses the shared What We Do section and retains the execution process', () => {
  assert.ok(
    oemPageSource.includes(
      "import ServiceGridSection from '../components/ServiceGridSection.astro'",
    ),
  );
  assert.ok(
    oemPageSource.includes('<ServiceGridSection services={site.services} sectionId="what-we-do"'),
  );
  assert.ok(!oemPageSource.includes('id={oneStop.id}'));
  assert.ok(oemPageSource.includes('<ProcessTimeline steps={process.steps} />'));
  assert.ok(oemPageSource.includes('<script is:inline>'));
  assert.ok(
    oemPageSource.includes('document.getElementById(window.location.hash.slice(1))'),
    'initial fragment navigation does not wait for media load',
  );
});
