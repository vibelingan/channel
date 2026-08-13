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
const ourPeopleSource = readFileSync(
  fileURLToPath(new URL('../components/OurTeamSection.astro', import.meta.url)),
  'utf8',
);
const qualitySource = readFileSync(
  fileURLToPath(new URL('../components/QualityTestingSection.astro', import.meta.url)),
  'utf8',
);
const factorySource = readFileSync(
  fileURLToPath(new URL('../components/FactorySection.astro', import.meta.url)),
  'utf8',
);
const whyChooseUsSource = readFileSync(
  fileURLToPath(new URL('../components/WhyChooseUsSection.astro', import.meta.url)),
  'utf8',
);
const ctaSource = readFileSync(
  fileURLToPath(new URL('../components/CTASection.astro', import.meta.url)),
  'utf8',
);
const footerSource = readFileSync(
  fileURLToPath(new URL('../components/SiteFooter.astro', import.meta.url)),
  'utf8',
);
const projectFormSource = readFileSync(
  fileURLToPath(new URL('../components/ProjectForm.astro', import.meta.url)),
  'utf8',
);
const teardownListingSource = readFileSync(
  fileURLToPath(new URL('../pages/_teardown-lab/index.astro', import.meta.url)),
  'utf8',
);
const teardownDetailSource = readFileSync(
  fileURLToPath(new URL('../pages/_teardown-lab/[slug].astro', import.meta.url)),
  'utf8',
);
const blueOceanListingSource = readFileSync(
  fileURLToPath(new URL('../pages/_blue-ocean/index.astro', import.meta.url)),
  'utf8',
);
const oemContent = readFileSync(
  fileURLToPath(new URL('./content/oem/en-US.md', import.meta.url)),
  'utf8',
);
const productCapabilityComponent = fileURLToPath(
  new URL('../components/ProductCapabilitySection.astro', import.meta.url),
);
const teardownTeaserComponent = fileURLToPath(
  new URL('../components/TeardownTeaser.astro', import.meta.url),
);
const blueOceanTeaserComponent = fileURLToPath(
  new URL('../components/BlueOceanTeaser.astro', import.meta.url),
);
const retainedContentPaths = [
  '../pages/_teardown-lab/index.astro',
  '../pages/_teardown-lab/[slug].astro',
  '../pages/_blue-ocean/index.astro',
  '../pages/_blue-ocean/[slug].astro',
  '../data/teardownReports.ts',
  '../data/blueOceanProducts.ts',
];
const hiddenRoutePaths = [
  '../pages/teardown-lab/index.astro',
  '../pages/teardown-lab/[slug].astro',
  '../pages/blue-ocean/index.astro',
  '../pages/blue-ocean/[slug].astro',
];

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

test('site header renders the CHANNEL wordmark with company name but no MOQ', () => {
  assert.equal(
    headerSource.match(/\{brand\.name\}/g)?.length,
    2,
    'company name is present in the Home link label and visible header text',
  );
  assert.ok(
    headerSource.includes('aria-label={`${brand.name} home`}'),
    'Home link has one descriptive accessible name',
  );
  assert.ok(headerSource.includes('alt=""'), 'decorative wordmark does not duplicate company name');
  assert.ok(
    headerSource.includes('data-company-name'),
    'header exposes the visible company name for responsive browser verification',
  );
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

test('site footer renders the configured ICP filing as a safe MIIT homepage link', () => {
  const footerBlock = enUS.match(/^footer:\n([\s\S]*?)^---$/m);
  assert.ok(footerBlock, 'footer content exists');
  assert.ok(footerBlock[1].includes('filingNumber: 粤ICP备2026092477号-1'));
  assert.ok(footerBlock[1].includes("filingUrl: 'https://beian.miit.gov.cn/'"));
  assert.ok(siteTypeSource.includes('filingNumber: string;'));
  assert.ok(siteTypeSource.includes('filingUrl: string;'));
  assert.ok(footerSource.includes('href={footer.filingUrl}'));
  assert.ok(footerSource.includes('{footer.filingNumber}'));
  assert.ok(footerSource.includes('target="_blank"'));
  assert.ok(footerSource.includes('rel="noopener noreferrer"'));
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

test('Factory and Our People use the exact confirmed client copy', () => {
  const normalizedContent = enUS.replace(/\s+/g, ' ');
  const requiredCopy = [
    'Founded in 2004, Diversity Technology Limited combines over 20 years of OEM manufacturing experience with AI-powered product development. By integrating market intelligence, material big data, and intelligent cost prediction into our engineering process, we help global brands launch smarter products faster—from concept to global delivery.',
    'Our People',
    'Global Trade Experts Behind Your Business',
    'With over 20 years of international trade experience, our multilingual sales, sourcing, and engineering teams have successfully supported brands, importers, distributors, and retailers across North America, Europe, the Middle East, Africa, and Asia.',
  ];

  for (const copy of requiredCopy) {
    assert.ok(normalizedContent.includes(copy), `missing confirmed Phase 3A copy: ${copy}`);
  }

  const factoryBlock = enUS.match(/^factory:\n([\s\S]*?)^ourPeople:/m);
  assert.ok(factoryBlock, 'factory content exists');
  assert.equal([...factoryBlock[1].matchAll(/^ {4}- value:/gm)].length, 4);
  for (const value of ["'20+'", "'40+'", "'5000+'", "'40+'"]) {
    assert.ok(factoryBlock[1].includes(`value: ${value}`));
  }
});

test('Our People consumes shared content while preserving all six client photos', () => {
  assert.ok(siteTypeSource.includes('ourPeople: {'));
  assert.ok(ourPeopleSource.includes("people: SiteContent['ourPeople']"));
  assert.ok(ourPeopleSource.includes('{people.eyebrow}'));
  assert.ok(ourPeopleSource.includes('{people.heading}'));
  assert.ok(ourPeopleSource.includes('{people.body}'));
  assert.equal((ourPeopleSource.match(/\/media\/oem\/team\/t\d{2}\.jpg/g) ?? []).length, 6);
  assert.ok(homepageSource.includes('ourPeople,'));
  assert.ok(homepageSource.includes('<OurTeamSection people={ourPeople} />'));
  assert.ok(!ourPeopleSource.includes('The team behind your product'));
});

test('Quality Assurance uses the exact confirmed client copy and all eight lab photos', () => {
  const normalizedContent = enUS.replace(/\s+/g, ' ');
  const requiredCopy = [
    'Quality Assurance',
    'From Risk Prevention to Final Inspection',
    'With our Pre-QC risk control system, potential risks are identified early. Every product is then subject to strict quality inspections throughout production and must pass final verification before export.',
  ];
  for (const copy of requiredCopy) {
    assert.ok(normalizedContent.includes(copy), `missing confirmed Quality copy: ${copy}`);
  }

  assert.ok(siteTypeSource.includes('quality: {'));
  assert.ok(qualitySource.includes("quality: SiteContent['quality']"));
  assert.ok(qualitySource.includes('{quality.eyebrow}'));
  assert.ok(qualitySource.includes('{quality.heading}'));
  assert.ok(qualitySource.includes('{quality.body}'));
  assert.equal((qualitySource.match(/\/media\/oem\/quality\/q\d\.jpg/g) ?? []).length, 8);
  assert.ok(!qualitySource.includes('In-House Testing &amp; Quality Control'));
});

test('homepage removes only the three confirmed sections and keeps the required flow', () => {
  for (const removed of [
    'ProductCapabilitySection',
    'TeardownTeaser',
    'BlueOceanTeaser',
    'productCapability,',
    'teardownTeaser,',
    'blueOceanTeaser,',
  ]) {
    assert.ok(
      !homepageSource.includes(removed),
      `homepage still includes removed section: ${removed}`,
    );
  }

  assert.ok(homepageSource.includes('quality,'));
  assert.ok(homepageSource.includes('<QualityTestingSection quality={quality} />'));
  for (const retained of [
    '<OemProcessSection process={oemProcess} />',
    '<FactorySection factory={factory} />',
    '<OurTeamSection people={ourPeople} />',
    '<WhyChooseUsSection why={whyChooseUs} />',
    '<CertificationsSection certs={certifications} />',
    '<CTASection cta={ctaSection} submit={submit} />',
  ]) {
    assert.ok(homepageSource.includes(retained), `homepage lost required section: ${retained}`);
  }
});

test('retired homepage Product Capability code is removed without affecting OEM capabilities', () => {
  assert.ok(!existsSync(productCapabilityComponent));
  assert.ok(!siteTypeSource.includes('export interface IconCard'));
  assert.ok(!siteTypeSource.includes('productCapability: {'));
  assert.ok(!/^productCapability:/m.test(enUS));
  assert.ok(oemContent.includes('capabilities:'));
  for (const category of [
    'Plastic Products',
    'Electronics',
    'Headphones',
    'Consumer Goods',
    'Hardware Products',
    'Promotional Products',
  ]) {
    assert.ok(oemContent.includes(category), `OEM capability remains available: ${category}`);
  }
});

test('Factory photos move from exterior to production lines and making details', () => {
  assert.ok(factorySource.includes('role="region"'));
  assert.ok(factorySource.includes('aria-label="Factory development and production gallery"'));
  assert.ok(factorySource.includes('tabindex="0"'));
});

test('retired homepage teaser code is removed and Teardown/Blue Ocean routes are hidden', () => {
  assert.ok(!existsSync(teardownTeaserComponent));
  assert.ok(!existsSync(blueOceanTeaserComponent));
  assert.ok(!siteTypeSource.includes('export interface ProductTeaserItem'));
  assert.ok(!siteTypeSource.includes('teardownTeaser: {'));
  assert.ok(!siteTypeSource.includes('blueOceanTeaser: {'));
  assert.ok(!/^teardownTeaser:/m.test(enUS));
  assert.ok(!/^blueOceanTeaser:/m.test(enUS));

  // Teardown Lab and Blue Ocean are temporarily hidden (2026-08): un-routed via
  // the `_` prefix convention (same as overstock), so they are not built, not in
  // the sitemap, and ship zero bytes. Content/data stay in the repo for re-enable.
  assert.ok(!enUS.includes("href: '/teardown-lab'"), 'site content must not link to /teardown-lab');
  assert.ok(!enUS.includes("href: '/blue-ocean'"), 'site content must not link to /blue-ocean');
  for (const relativePath of retainedContentPaths) {
    assert.ok(
      existsSync(fileURLToPath(new URL(relativePath, import.meta.url))),
      `hidden source/data file retained: ${relativePath}`,
    );
  }
  for (const relativePath of hiddenRoutePaths) {
    assert.ok(
      !existsSync(fileURLToPath(new URL(relativePath, import.meta.url))),
      `public route must stay un-routed: ${relativePath}`,
    );
  }
});

test('Why Choose Us defines the exact five AI advantage stories in client order', () => {
  assert.ok(siteTypeSource.includes('export interface AiAdvantageStory'));
  assert.ok(siteTypeSource.includes('stories: AiAdvantageStory[]'));

  const whyBlock = enUS.match(/^whyChooseUs:\n([\s\S]*?)^quality:/m);
  assert.ok(whyBlock, 'Why Choose Us content exists');
  const normalizedWhy = whyBlock[1].replace(/\s+/g, ' ');
  const requiredCopy = [
    'More Than Manufacturing — Your AI-Powered Product Innovation & Supply Chain Partner',
    'AI Proactive Incubation',
    'Turn client’s rough ideas & simple sketches into complete product solutions, no finished technical drawings needed.',
    'Early-stage R&D empowerment, zero threshold for product innovation.',
    'Smart R&D & Fast Iteration',
    'Replace repeated physical sampling with AI virtual simulation to shorten development cycle.',
    'Drastically cut iteration time and R&D trial-and-error cost.',
    'Global AI Supply Chain',
    'AI material big data supports instant material selection, dynamic cost optimization and global cross-border delivery.',
    'Transparent cost, stable supply and fast global shipping.',
    'Pre-QC Risk Control',
    'AI full-process pre-inspection replaces traditional post-production quality check.',
    'Eliminate quality risks in advance, stabilize mass production yield.',
    'Long-Term Brand Co-Growth',
    'Continuous product iteration and cost optimization based on market data, instead of one-time OEM manufacturing.',
    'Sustainable brand growth and long-term market competitiveness.',
  ];
  for (const copy of requiredCopy) {
    assert.ok(normalizedWhy.includes(copy), `missing confirmed AI advantage copy: ${copy}`);
  }

  const storyBlocks = whyBlock[1].split(/^ {4}- number: /m).slice(1);
  assert.equal(storyBlocks.length, 5, 'exactly five AI advantage stories');
  assert.deepEqual(
    storyBlocks.map((story) => story.match(/^'?(\d{2})'?/m)?.[1]),
    ['01', '02', '03', '04', '05'],
  );
  assert.deepEqual(
    storyBlocks.map((story) => story.match(/^ {6}visual: (\S+)/m)?.[1]),
    ['incubation', 'iteration', 'supply-chain', 'pre-qc', 'co-growth'],
  );
});

test('Why Choose Us renders five accessible static concept visuals, not a fake live system', () => {
  assert.ok(whyChooseUsSource.includes('why.stories.map'));
  assert.ok(whyChooseUsSource.includes('data-visual={story.visual}'));
  assert.ok(whyChooseUsSource.includes('aria-label={story.visualSummary}'));
  assert.ok(whyChooseUsSource.includes('{story.scenario}'));
  assert.ok(whyChooseUsSource.includes('{story.sellingPoint}'));
  assert.ok(whyChooseUsSource.includes('{why.visualDisclaimer}'));
  assert.ok(whyChooseUsSource.includes('storyIndex % 2'));
  assert.ok(
    whyChooseUsSource.includes(
      "data-story-layout={storyIndex % 2 === 1 ? 'visual-first' : 'text-first'}",
    ),
  );
  assert.ok(whyChooseUsSource.includes("storyIndex % 2 === 1 ? 'lg:order-2' : 'lg:order-1'"));
  assert.ok(whyChooseUsSource.includes("storyIndex % 2 === 1 ? 'lg:order-1' : 'lg:order-2'"));
  assert.equal((whyChooseUsSource.match(/story\.visual ===/g) ?? []).length, 5);
  for (const visualCopy of [
    'Market trend',
    '60 days',
    '15 days',
    'Material match',
    'Risk control',
    'Market growth',
  ]) {
    assert.ok(whyChooseUsSource.includes(visualCopy), `missing visual concept: ${visualCopy}`);
  }
  assert.ok(!whyChooseUsSource.includes('/media/oem/team/team.jpg'));
  assert.ok(!whyChooseUsSource.includes('ReasonItem'));
  assert.ok(!whyChooseUsSource.includes('<button'));
  assert.ok(!whyChooseUsSource.includes('<input'));
  assert.ok(!whyChooseUsSource.includes('animate-'));
});

test('homepage CTA embeds the existing full secure ProjectForm at #oem-inquiry', () => {
  assert.ok(ctaSource.includes("import ProjectForm from './ProjectForm.astro'"));
  assert.ok(ctaSource.includes("submit: OemContent['submit']"));
  assert.ok(ctaSource.includes('id="oem-inquiry"'));
  assert.ok(ctaSource.includes('scroll-mt-[var(--spacing-header)]'));
  assert.ok(ctaSource.includes('fields={submit.fields}'));
  assert.ok(ctaSource.includes('submitLabel={submit.submitLabel}'));
  assert.ok(ctaSource.includes('disclaimer={submit.disclaimer}'));
  assert.ok(ctaSource.includes('successTitle={submit.successTitle}'));
  assert.ok(ctaSource.includes('successBody={submit.successBody}'));
  assert.ok(ctaSource.includes('action="/api/admin"'));
  assert.ok(ctaSource.includes('resultPath="/oem_submit_result"'));
  assert.ok(!ctaSource.includes('cta.primaryCta'));
  assert.ok(!ctaSource.includes('cta.secondaryCta'));

  assert.ok(homepageSource.includes("import { getOemContent } from '../i18n/oem.ts'"));
  assert.ok(homepageSource.includes('const { submit } = getOemContent(DEFAULT_LOCALE)'));
  assert.ok(homepageSource.includes('<CTASection cta={ctaSection} submit={submit} />'));
  assert.equal((ctaSource.match(/id="oem-inquiry"/g) ?? []).length, 1);

  for (const secureContract of [
    "'createOemFileUploadIntent'",
    "'submitProject'",
    'OEM_FILE_MAX_BYTES',
    'isAllowedOemExtension',
    // Bytes go straight to COS as a raw PUT carrying the server-minted
    // credential headers. This previously pinned the multipart form
    // (`cos.append('file', file)`) — i.e. it defended the exact protocol
    // @cloudbase/node-sdk 3.x had stopped signing for. Pin verb + credential
    // placement instead of the encoding that happened to be in use.
    'headers: intent.upload.headers',
    'body: file',
  ]) {
    assert.ok(projectFormSource.includes(secureContract), `ProjectForm keeps: ${secureContract}`);
  }
  // And must never regress to a multipart form against a PUT-scoped signature.
  assert.ok(
    !projectFormSource.includes('new FormData()'),
    'ProjectForm must not rebuild a multipart upload form',
  );
});

test('Teardown listing removes only the aggregate stats band', () => {
  assert.ok(!teardownListingSource.includes('<!-- Stats strip -->'));
  assert.doesNotMatch(teardownListingSource, /\b(?:avgMargin|totalReports)\b/);
  for (const retained of [
    'const reports = getAllReports();',
    'reports.map',
    '<TeardownCard report={report} />',
    'Latest Reports',
    'Our Methodology',
    'href={OEM_INQUIRY_HREF}',
  ]) {
    assert.ok(teardownListingSource.includes(retained), `Teardown listing retains: ${retained}`);
  }

  for (const retained of [
    'export function getStaticPaths()',
    'bomBreakdown',
    'report.estMargin',
    'report.moq',
    'href={OEM_INQUIRY_HREF}',
  ]) {
    assert.ok(teardownDetailSource.includes(retained), `Teardown details retain: ${retained}`);
  }
});

test('Blue Ocean listing removes only the aggregate stats band', () => {
  assert.ok(!blueOceanListingSource.includes('<!-- Stats strip -->'));
  assert.doesNotMatch(blueOceanListingSource, /\b(?:avgMargin|totalProducts|minMoq)\b/);
  for (const retained of [
    'const products = getAllProducts();',
    'products.map',
    '<ProductConceptCard product={product} />',
    'Concept Portfolio',
    'Three Ways to Partner',
    'href={OEM_INQUIRY_HREF}',
  ]) {
    assert.ok(blueOceanListingSource.includes(retained), `Blue Ocean listing retains: ${retained}`);
  }
});

test('OEM content uses the approved experience and shared response-time claims', () => {
  const normalizedOemContent = oemContent.replace(/\s+/g, ' ');
  assert.ok(
    normalizedOemContent.includes("stat: '20+', label: Years of Experience"),
    'OEM experience stat uses the PPT-approved 20+',
  );
  assert.ok(
    normalizedOemContent.includes(
      'Our engineering team will review your details and get back to you within 24 hours.',
    ),
    'shared ProjectForm success copy uses the PPT-approved response time',
  );
  assert.doesNotMatch(normalizedOemContent, /15\+|business day/i);
  assert.ok(oemPageSource.includes('successBody={submit.successBody}'));
});
