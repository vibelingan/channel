import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const enUS = readFileSync(fileURLToPath(new URL('./content/en-US.md', import.meta.url)), 'utf8');

test('home keeps the real team gallery separate from Why Choose Us visuals', () => {
  const ourTeam = readFileSync(
    fileURLToPath(new URL('../components/OurTeamSection.astro', import.meta.url)),
    'utf8',
  );
  const whyChooseUs = readFileSync(
    fileURLToPath(new URL('../components/WhyChooseUsSection.astro', import.meta.url)),
    'utf8',
  );
  assert.equal(
    (ourTeam.match(/\/media\/oem\/team\/t\d{2}\.jpg/g) ?? []).length,
    6,
    'Our People retains all six client team photos',
  );
  assert.ok(!whyChooseUs.includes('/media/oem/team/team.jpg'), 'duplicate team photo removed');
  assert.ok(
    !whyChooseUs.includes('/media/section-heritage.png'),
    'placeholder heritage illustration no longer referenced',
  );
});

test('every /media asset referenced by site + OEM + portfolio content exists in public/', () => {
  const others = ['./content/oem/en-US.md', './content/portfolio/en-US.md'].map((p) =>
    readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'),
  );
  const all = [enUS, ...others].join('\n');
  // Path stops at whitespace / comma / closing brace / quote (handles inline YAML).
  const refs = [...all.matchAll(/(?:image|logo|poster|src):\s*['"]?(\/media\/[^\s,}'"]+)/g)].map(
    (m) => m[1],
  );
  assert.ok(refs.length > 0, 'found media references');
  for (const ref of refs) {
    const file = fileURLToPath(new URL(`../../public${ref}`, import.meta.url));
    assert.ok(existsSync(file), `referenced asset missing on disk: ${ref}`);
  }
});

test('OEM process images expose reviewed intrinsic dimensions to the renderer', () => {
  const frontmatterSource = enUS.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontmatterSource, 'site content has YAML frontmatter');
  const document = parseDocument(frontmatterSource[1], { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const content = document.toJS() as {
    oemProcess?: {
      steps?: Array<{ label?: string; imageWidth?: number; imageHeight?: number }>;
    };
  };
  assert.ok(content.oemProcess?.steps);
  assert.deepEqual(
    content.oemProcess.steps.map(({ label, imageWidth, imageHeight }, index) => ({
      src: `/media/oem/process/p${String(index + 1).padStart(2, '0')}.jpg`,
      alt: `Step ${index + 1}: ${label}`,
      imageWidth,
      imageHeight,
    })),
    [
      {
        src: '/media/oem/process/p01.jpg',
        alt: 'Step 1: Sketches',
        imageWidth: 720,
        imageHeight: 518,
      },
      {
        src: '/media/oem/process/p02.jpg',
        alt: 'Step 2: Appearance Design',
        imageWidth: 720,
        imageHeight: 690,
      },
      {
        src: '/media/oem/process/p03.jpg',
        alt: 'Step 3: Mechanical Design',
        imageWidth: 720,
        imageHeight: 623,
      },
      {
        src: '/media/oem/process/p04.jpg',
        alt: 'Step 4: Circuit Design',
        imageWidth: 540,
        imageHeight: 720,
      },
      {
        src: '/media/oem/process/p05.jpg',
        alt: 'Step 5: Prototyping',
        imageWidth: 662,
        imageHeight: 720,
      },
      {
        src: '/media/oem/process/p06.jpg',
        alt: 'Step 6: Mold Building',
        imageWidth: 720,
        imageHeight: 412,
      },
      {
        src: '/media/oem/process/p07.jpg',
        alt: 'Step 7: PCBA Mass Prod',
        imageWidth: 720,
        imageHeight: 549,
      },
      {
        src: '/media/oem/process/p08.jpg',
        alt: 'Step 8: Mold Test Shot',
        imageWidth: 720,
        imageHeight: 657,
      },
      {
        src: '/media/oem/process/p09.jpg',
        alt: 'Step 9: Pilot Run',
        imageWidth: 720,
        imageHeight: 697,
      },
      {
        src: '/media/oem/process/p10.jpg',
        alt: 'Step 10: QC',
        imageWidth: 720,
        imageHeight: 464,
      },
    ],
  );

  const processComponent = readFileSync(
    fileURLToPath(new URL('../components/OemProcessSection.astro', import.meta.url)),
    'utf8',
  );
  assert.match(
    processComponent,
    /src=\{`\/media\/oem\/process\/p\$\{String\(index \+ 1\)\.padStart\(2, '0'\)\}\.jpg`\}/,
  );
  assert.match(processComponent, /alt=\{`Step \$\{index \+ 1\}: \$\{step\.label\}`\}/);
  assert.match(processComponent, /width=\{step\.imageWidth\}/);
  assert.match(processComponent, /height=\{step\.imageHeight\}/);
});
