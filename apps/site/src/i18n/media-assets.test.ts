import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from '@astrojs/compiler';
import type { Node as AstroNode, ElementNode, ExpressionNode } from '@astrojs/compiler/types';
import sharp from 'sharp';
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
        assert.equal(element.properties.length, propertyNames.length);
        assert.equal(properties.size, element.properties.length, 'object properties are unique');
        assert.deepEqual([...properties.keys()].sort(), [...propertyNames].sort());
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

type MapContext = {
  itemName: string;
  indexName?: string;
};

const extractMapContext = (expression: ExpressionNode) => {
  const firstChild = expression.children[0];
  const lastChild = expression.children.at(-1);
  assert.ok(firstChild?.type === 'text');
  assert.ok(lastChild?.type === 'text');
  const source = ts.createSourceFile(
    'mapped-image.ts',
    `${firstChild.value}null${lastChild.value}`,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(source.statements.length, 1);
  const statement = source.statements[0];
  assert.ok(ts.isExpressionStatement(statement));
  const call = statement.expression;
  assert.ok(ts.isCallExpression(call));
  assert.ok(ts.isPropertyAccessExpression(call.expression));
  assert.equal(call.expression.name.text, 'map');
  assert.equal(call.arguments.length, 1);
  const callback = call.arguments[0];
  assert.ok(ts.isArrowFunction(callback));
  assert.ok(callback.parameters.length === 1 || callback.parameters.length === 2);
  const parameters = callback.parameters.map((parameter) => {
    assert.ok(ts.isIdentifier(parameter.name));
    return parameter.name.text;
  });
  return {
    registryExpression: call.expression.expression.getText(source),
    context: { itemName: parameters[0], indexName: parameters[1] } satisfies MapContext,
  };
};

const assertImageMetadata = async (
  items: Array<Record<string, string | number>>,
  pathProperty: string,
  widthProperty: string,
  heightProperty: string,
) => {
  for (const item of items) {
    const path = item[pathProperty];
    const width = item[widthProperty];
    const height = item[heightProperty];
    assert.equal(typeof path, 'string');
    assert.equal(typeof width, 'number');
    assert.equal(typeof height, 'number');
    const file = fileURLToPath(new URL(`../../public${path}`, import.meta.url));
    assert.ok(existsSync(file), `referenced asset missing on disk: ${path}`);
    const metadata = await sharp(file).metadata();
    assert.equal(metadata.autoOrient.width, width, `${path} width matches its source bytes`);
    assert.equal(metadata.autoOrient.height, height, `${path} height matches its source bytes`);
  }
};

const assertMappedImageRenderer = async (
  componentSource: string,
  registryExpression: string,
  expectedBindings: (context: MapContext) => Record<string, string>,
  expectedMappedText?: { elementName: string; value: (context: MapContext) => string },
  expectedImageTemplates = 1,
  expectedSectionHeading?: string,
) => {
  const { ast, diagnostics } = await parse(componentSource);
  assert.deepEqual(diagnostics, []);
  const images: Array<{
    node: ElementNode;
    expression?: ExpressionNode;
    elementAncestors: ElementNode[];
  }> = [];
  const mappedTextElements: Array<{ node: ElementNode; expression?: ExpressionNode }> = [];

  const visit = (
    node: AstroNode,
    expression?: ExpressionNode,
    elementAncestors: ElementNode[] = [],
  ) => {
    const currentExpression = node.type === 'expression' ? node : expression;
    if (node.type === 'element' && node.name === 'img') {
      images.push({ node, expression: currentExpression, elementAncestors });
    }
    if (node.type === 'element' && node.name === expectedMappedText?.elementName) {
      mappedTextElements.push({ node, expression: currentExpression });
    }
    if ('children' in node) {
      const childAncestors =
        node.type === 'element' ? [...elementAncestors, node] : elementAncestors;
      for (const child of node.children) visit(child, currentExpression, childAncestors);
    }
  };
  visit(ast);

  assert.equal(images.length, expectedImageTemplates, 'component renders expected image templates');
  const mappedImages = images.map((image) => {
    assert.ok(image.expression, 'gallery image is rendered by a collection expression');
    return { ...image, map: extractMapContext(image.expression) };
  });
  const matchingImages = mappedImages.filter(
    ({ map }) => map.registryExpression === registryExpression,
  );
  assert.equal(
    matchingImages.length,
    1,
    'map expression renders one registry-backed image template',
  );
  const image = matchingImages[0];
  assert.ok(
    image.node.attributes.every((attribute) => attribute.kind !== 'spread'),
    'registry-backed image does not allow attribute spreads',
  );
  const attributes = new Map(
    image.node.attributes.map((attribute) => [
      attribute.name,
      { kind: attribute.kind, value: attribute.value },
    ]),
  );
  assert.equal(attributes.size, image.node.attributes.length, 'image attributes are unique');
  for (const [name, value] of Object.entries(expectedBindings(image.map.context))) {
    assert.deepEqual(attributes.get(name), { kind: 'expression', value });
  }

  if (expectedSectionHeading) {
    const sectionContainer = image.elementAncestors.findLast((ancestor) =>
      ancestor.children.some((child) => child.type === 'element' && child.name === 'h3'),
    );
    assert.ok(sectionContainer, 'mapped image has a section heading ancestor');
    const headings = sectionContainer.children.filter(
      (child): child is ElementNode => child.type === 'element' && child.name === 'h3',
    );
    assert.equal(headings.length, 1);
    const headingChildren = headings[0].children.filter(
      (child) => child.type !== 'text' || child.value.trim() !== '',
    );
    assert.deepEqual(
      headingChildren.map((child) =>
        child.type === 'text'
          ? { type: child.type, value: child.value.trim() }
          : { type: child.type },
      ),
      [{ type: 'text', value: expectedSectionHeading }],
    );
  }

  if (expectedMappedText) {
    assert.equal(
      mappedTextElements.length,
      1,
      `component renders one ${expectedMappedText.elementName}`,
    );
    const textElement = mappedTextElements[0];
    assert.equal(
      textElement.expression,
      image.expression,
      'image and text use the same map expression',
    );
    const meaningfulChildren = textElement.node.children.filter(
      (child) => child.type !== 'text' || child.value.trim() !== '',
    );
    assert.equal(meaningfulChildren.length, 1);
    const valueExpression = meaningfulChildren[0];
    assert.ok(valueExpression.type === 'expression');
    assert.deepEqual(
      valueExpression.children.map((child) =>
        child.type === 'text'
          ? { type: child.type, value: child.value.trim() }
          : { type: child.type },
      ),
      [{ type: 'text', value: expectedMappedText.value(image.map.context) }],
    );
  }
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

test('OEM process images expose reviewed intrinsic dimensions to the renderer', async () => {
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
  const processImages = content.oemProcess.steps.map(
    ({ label, imageWidth, imageHeight }, index) => ({
      src: `/media/oem/process/p${String(index + 1).padStart(2, '0')}.jpg`,
      alt: `Step ${index + 1}: ${label}`,
      imageWidth,
      imageHeight,
    }),
  );
  assert.deepEqual(processImages, [
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
  ]);
  await assertImageMetadata(processImages, 'src', 'imageWidth', 'imageHeight');

  const processComponent = readFileSync(
    fileURLToPath(new URL('../components/OemProcessSection.astro', import.meta.url)),
    'utf8',
  );
  await assertMappedImageRenderer(processComponent, 'process.steps', ({ itemName, indexName }) => {
    assert.ok(indexName);
    return {
      src: `\`/media/oem/process/p\${String(${indexName} + 1).padStart(2, '0')}.jpg\``,
      alt: `\`Step \${${indexName} + 1}: \${${itemName}.label}\``,
      width: `${itemName}.imageWidth`,
      height: `${itemName}.imageHeight`,
    };
  });
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
  await assertImageMetadata(items, 'src', 'width', 'height');
  await assertMappedImageRenderer(factoryComponent, 'factoryPhotos', ({ itemName }) => {
    return {
      src: `${itemName}.src`,
      alt: `${itemName}.alt`,
      width: `${itemName}.width`,
      height: `${itemName}.height`,
    };
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
  await assertImageMetadata(items, 'img', 'width', 'height');
  await assertMappedImageRenderer(teamComponent, 'photos', ({ itemName }) => {
    return {
      src: `${itemName}.img`,
      alt: `${itemName}.alt`,
      width: `${itemName}.width`,
      height: `${itemName}.height`,
    };
  });
});

test('quality images expose reviewed intrinsic dimensions to the renderer', async () => {
  const qualityComponent = readFileSync(
    fileURLToPath(new URL('../components/QualityTestingSection.astro', import.meta.url)),
    'utf8',
  );
  const { items } = extractLiteralObjectArray(
    qualityComponent,
    'QualityTestingSection.astro',
    'tests',
    ['img', 'label', 'width', 'height'],
  );
  assert.deepEqual(items, [
    {
      img: '/media/oem/quality/q1.jpg',
      label: 'QC Inspection Lab',
      width: 545,
      height: 345,
    },
    {
      img: '/media/oem/quality/q2.jpg',
      label: 'Burst / Pressure Test',
      width: 205,
      height: 345,
    },
    {
      img: '/media/oem/quality/q3.jpg',
      label: 'Press-Force Test',
      width: 205,
      height: 345,
    },
    {
      img: '/media/oem/quality/q4.jpg',
      label: 'Salt-Spray Corrosion Test',
      width: 322,
      height: 345,
    },
    {
      img: '/media/oem/quality/q5.jpg',
      label: 'Vibration / Transport Test',
      width: 325,
      height: 285,
    },
    {
      img: '/media/oem/quality/q6.jpg',
      label: 'Environmental Aging Chamber',
      width: 285,
      height: 285,
    },
    {
      img: '/media/oem/quality/q7.jpg',
      label: 'Tensile / Pull Test',
      width: 368,
      height: 285,
    },
    {
      img: '/media/oem/quality/q8.jpg',
      label: 'Drop Test',
      width: 305,
      height: 285,
    },
  ]);
  await assertImageMetadata(items, 'img', 'width', 'height');
  await assertMappedImageRenderer(
    qualityComponent,
    'tests',
    ({ itemName }) => ({
      src: `${itemName}.img`,
      alt: `${itemName}.label`,
      width: `${itemName}.width`,
      height: `${itemName}.height`,
    }),
    { elementName: 'figcaption', value: ({ itemName }) => `${itemName}.label` },
  );
});

test('certificate and client images expose reviewed intrinsic dimensions to the renderer', async () => {
  const certificationsComponent = readFileSync(
    fileURLToPath(new URL('../components/CertificationsSection.astro', import.meta.url)),
    'utf8',
  );
  const certificates = extractLiteralObjectArray(
    certificationsComponent,
    'CertificationsSection.astro',
    'complianceCerts',
    ['name', 'img', 'description', 'width', 'height'],
  );
  assert.deepEqual(certificates.items, [
    {
      name: 'CE',
      img: '/media/oem/certs/ce.jpg',
      description: 'European conformity',
      width: 706,
      height: 1000,
    },
    {
      name: 'EMC',
      img: '/media/oem/certs/emc.jpg',
      description: 'Electromagnetic compatibility',
      width: 707,
      height: 1000,
    },
    {
      name: 'FCC',
      img: '/media/oem/certs/fcc.jpg',
      description: 'U.S. FCC compliance',
      width: 706,
      height: 1000,
    },
    {
      name: 'JD',
      img: '/media/oem/certs/jd.jpg',
      description: 'Retail channel quality',
      width: 772,
      height: 1000,
    },
  ]);
  await assertImageMetadata(certificates.items, 'img', 'width', 'height');
  await assertMappedImageRenderer(
    certificationsComponent,
    'complianceCerts',
    ({ itemName }) => ({
      src: `${itemName}.img`,
      alt: `\`\${${itemName}.name} certification\``,
      width: `${itemName}.width`,
      height: `${itemName}.height`,
    }),
    undefined,
    2,
    'Company &amp; Compliance',
  );

  const clients = extractLiteralObjectArray(
    certificationsComponent,
    'CertificationsSection.astro',
    'clientLogos',
    ['name', 'img', 'width', 'height'],
  );
  assert.deepEqual(clients.items, [
    {
      name: 'Artcoustic',
      img: '/media/oem/clients/artcoustic.png',
      width: 400,
      height: 65,
    },
    {
      name: 'Audio Diversity',
      img: '/media/oem/clients/audio-diversity.png',
      width: 400,
      height: 124,
    },
    {
      name: 'CoreMee',
      img: '/media/oem/clients/coremee.png',
      width: 400,
      height: 87,
    },
    {
      name: 'DI',
      img: '/media/oem/clients/di.png',
      width: 400,
      height: 120,
    },
    {
      name: 'pabobo',
      img: '/media/oem/clients/pabobo.jpg',
      width: 400,
      height: 400,
    },
    {
      name: 'AS',
      img: '/media/oem/clients/as.png',
      width: 400,
      height: 400,
    },
  ]);
  await assertImageMetadata(clients.items, 'img', 'width', 'height');
  await assertMappedImageRenderer(
    certificationsComponent,
    'clientLogos',
    ({ itemName }) => ({
      src: `${itemName}.img`,
      alt: `\`\${${itemName}.name} logo\``,
      width: `${itemName}.width`,
      height: `${itemName}.height`,
    }),
    undefined,
    2,
    'Global Clients',
  );
});
