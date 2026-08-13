import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from '@astrojs/compiler';
import type { Node as AstroNode, ElementNode, ExpressionNode } from '@astrojs/compiler/types';
import ts from 'typescript';
import { parseDocument } from 'yaml';

const enUS = readFileSync(fileURLToPath(new URL('./content/en-US.md', import.meta.url)), 'utf8');

const extractLiteralObjectArray = (
  componentSource: string,
  componentName: string,
  variableName: string,
  propertyNames: string[],
) => {
  const frontmatter = componentSource.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontmatter, `${componentName} has Astro frontmatter`);
  const script = ts.createSourceFile(
    `${componentName}.ts`,
    frontmatter[1],
    ts.ScriptTarget.Latest,
    true,
  );
  let result: Array<Record<string, string | number>> | undefined;

  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName
    ) {
      assert.equal(result, undefined, `${variableName} is declared once`);
      const initializer = node.initializer;
      assert.ok(initializer && ts.isArrayLiteralExpression(initializer));
      result = initializer.elements.map((element) => {
        assert.ok(ts.isObjectLiteralExpression(element));
        const properties = new Map(
          element.properties.map((property) => {
            assert.ok(ts.isPropertyAssignment(property));
            assert.ok(ts.isIdentifier(property.name));
            return [property.name.text, property.initializer] as const;
          }),
        );
        assert.deepEqual([...properties.keys()], propertyNames);
        return Object.fromEntries(
          propertyNames.map((propertyName) => {
            const value = properties.get(propertyName);
            assert.ok(value);
            if (ts.isStringLiteral(value)) return [propertyName, value.text];
            assert.ok(ts.isNumericLiteral(value));
            return [propertyName, Number(value.text)];
          }),
        );
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(script);
  assert.ok(result, `${componentName} declares ${variableName}`);
  return {
    items: result,
  };
};

const assertMappedImageRenderer = async (
  componentSource: string,
  mapExpressionStart: string,
  expectedBindings: Record<string, string>,
) => {
  const { ast, diagnostics } = await parse(componentSource);
  assert.deepEqual(diagnostics, []);
  const images: Array<{ node: ElementNode; expression?: ExpressionNode }> = [];

  const visit = (node: AstroNode, expression?: ExpressionNode) => {
    const currentExpression = node.type === 'expression' ? node : expression;
    if (node.type === 'element' && node.name === 'img') {
      images.push({ node, expression: currentExpression });
    }
    if ('children' in node) {
      for (const child of node.children) visit(child, currentExpression);
    }
  };
  visit(ast);

  assert.equal(images.length, 1, 'component renders one registry-backed image template');
  const image = images[0];
  assert.ok(image.expression, 'gallery image is rendered by a collection expression');
  const attributes = new Map(
    image.node.attributes.map((attribute) => [
      attribute.name,
      { kind: attribute.kind, value: attribute.value },
    ]),
  );
  assert.equal(attributes.size, image.node.attributes.length, 'image attributes are unique');
  for (const [name, value] of Object.entries(expectedBindings)) {
    assert.deepEqual(attributes.get(name), { kind: 'expression', value });
  }

  const firstExpressionChild = image.expression.children[0];
  const lastExpressionChild = image.expression.children.at(-1);
  assert.ok(firstExpressionChild?.type === 'text');
  assert.equal(firstExpressionChild.value.trim(), mapExpressionStart);
  assert.ok(lastExpressionChild?.type === 'text');
  assert.equal(lastExpressionChild.value.trim(), '))');
};

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

test('factory gallery images expose reviewed intrinsic dimensions to the renderer', async () => {
  const factoryComponent = readFileSync(
    fileURLToPath(new URL('../components/FactorySection.astro', import.meta.url)),
    'utf8',
  );
  const expectedPhotos = [
    {
      src: '/media/oem/factory/f03.jpg',
      alt: 'Factory facility entrance',
      width: 1280,
      height: 817,
    },
    {
      src: '/media/oem/factory/f10.jpg',
      alt: 'ISO-certified factory campus',
      width: 1280,
      height: 588,
    },
    {
      src: '/media/oem/factory/f07.jpg',
      alt: 'Factory exterior and loading yard',
      width: 1280,
      height: 590,
    },
    {
      src: '/media/oem/factory/f08.jpg',
      alt: 'Injection molding workshop',
      width: 1280,
      height: 916,
    },
    {
      src: '/media/oem/factory/f04.jpg',
      alt: 'Product assembly and packing line',
      width: 1280,
      height: 713,
    },
    {
      src: '/media/oem/factory/f09.jpg',
      alt: 'Product coating and finishing line',
      width: 1280,
      height: 587,
    },
    {
      src: '/media/oem/factory/f05.jpg',
      alt: 'Product printing and finishing',
      width: 1280,
      height: 918,
    },
    {
      src: '/media/oem/factory/f01.jpg',
      alt: 'Product design and 3D engineering',
      width: 1280,
      height: 651,
    },
    {
      src: '/media/oem/factory/f02.jpg',
      alt: 'Precision production mold',
      width: 1280,
      height: 568,
    },
    {
      src: '/media/oem/factory/f06.jpg',
      alt: 'Tooling detail and mold cavity',
      width: 1280,
      height: 720,
    },
  ];
  const { items } = extractLiteralObjectArray(
    factoryComponent,
    'FactorySection.astro',
    'factoryPhotos',
    ['src', 'alt', 'width', 'height'],
  );
  assert.deepEqual(items, expectedPhotos);
  await assertMappedImageRenderer(factoryComponent, 'factoryPhotos.map((photo) => (', {
    src: 'photo.src',
    alt: 'photo.alt',
    width: 'photo.width',
    height: 'photo.height',
  });
});

test('team gallery images expose reviewed intrinsic dimensions to the renderer', async () => {
  const teamComponent = readFileSync(
    fileURLToPath(new URL('../components/OurTeamSection.astro', import.meta.url)),
    'utf8',
  );
  const { items } = extractLiteralObjectArray(teamComponent, 'OurTeamSection.astro', 'photos', [
    'img',
    'alt',
    'width',
    'height',
  ]);
  assert.deepEqual(items, [
    {
      img: '/media/oem/team/t01.jpg',
      alt: 'The Diversity Technology team',
      width: 1100,
      height: 749,
    },
    {
      img: '/media/oem/team/t02.jpg',
      alt: 'Sales and engineering team',
      width: 1100,
      height: 850,
    },
    {
      img: '/media/oem/team/t03.jpg',
      alt: 'At an international trade show',
      width: 1100,
      height: 822,
    },
    {
      img: '/media/oem/team/t04.jpg',
      alt: 'Exhibition booth',
      width: 1100,
      height: 822,
    },
    {
      img: '/media/oem/team/t05.jpg',
      alt: 'Team at work',
      width: 1100,
      height: 618,
    },
    {
      img: '/media/oem/team/t06.jpg',
      alt: 'Product showcase',
      width: 1100,
      height: 825,
    },
  ]);
  await assertMappedImageRenderer(teamComponent, 'photos.map((p, i) => (', {
    src: 'p.img',
    alt: 'p.alt',
    width: 'p.width',
    height: 'p.height',
  });
});
