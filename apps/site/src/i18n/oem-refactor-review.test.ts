import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectForm = readFileSync(
  fileURLToPath(new URL('../components/ProjectForm.astro', import.meta.url)),
  'utf8',
);
const mediaPolicy = readFileSync(
  fileURLToPath(new URL('../../../../docs/IMAGE_UPLOAD_STORAGE_DESIGN.md', import.meta.url)),
  'utf8',
);
const mediaVideo = readFileSync(
  fileURLToPath(new URL('../components/MediaVideo.astro', import.meta.url)),
  'utf8',
);
const oemDesign = readFileSync(
  fileURLToPath(new URL('../../../../docs/oem-refresh/DESIGN.md', import.meta.url)),
  'utf8',
);
const productionPlan = readFileSync(
  fileURLToPath(new URL('../../../../docs/CICD_PRODUCTION_PLAN.md', import.meta.url)),
  'utf8',
);
const deploymentDesign = readFileSync(
  fileURLToPath(new URL('../../../../docs/CLOUDBASE_DEPLOYMENT_DESIGN.md', import.meta.url)),
  'utf8',
);

test('ProjectForm associates helper text with text and file controls', () => {
  const inputMarkup = projectForm.match(/<input[\s\S]*?\/>/g) ?? [];
  assert.ok(inputMarkup.length >= 2);
  for (const input of inputMarkup) {
    assert.match(input, /aria-describedby=\{field\.hint \? `\$\{field\.name\}-hint` : undefined\}/);
  }
});

test('ProjectForm states that JavaScript is required instead of claiming a native submit fallback', () => {
  assert.match(projectForm, /<noscript>/);
  assert.match(projectForm, /JavaScript is required to submit this project securely/);
  assert.match(projectForm, /aria-describedby="project-form-runtime-note"/);
  assert.match(projectForm, /data-degradation-reviewed="JS-only JSON and signed-storage flow/);
  assert.doesNotMatch(projectForm, /degrades gracefully\s+without JS/i);
});

test('marketing video policy documents the bounded reviewed static-launch exception', () => {
  const videoPolicy = mediaPolicy
    .split('\n')
    .find((line) => line.startsWith('| `marketing-media` (video)'));
  assert.ok(videoPolicy);
  assert.match(videoPolicy, /signed raw COS `PUT`/);
  assert.doesNotMatch(videoPolicy, /\bPOST\b/);
  assert.doesNotMatch(mediaPolicy, /COS[^\n]{0,40}\bPOST\b|\bPOST\b[^\n]{0,40}COS/);
  assert.doesNotMatch(mediaPolicy, /method:\s*[`'"]?POST|multipart\s+[`'"]?POST/);
  assert.match(mediaPolicy, /Reviewed static launch video/);
  assert.match(mediaPolicy, /20 MiB/);
  assert.match(mediaPolicy, /apps\/site\/public\/media\/oem-factory\.mp4/);
  assert.match(mediaPolicy, /New or replaced marketing videos must use CloudBase Storage/);
  assert.match(mediaPolicy, /explicitly prune\s+`?\/media\/oem-factory\.mp4`?/);
  assert.match(mediaVideo, /reviewed static-launch path/);
  assert.doesNotMatch(mediaVideo, /intentionally NOT bundled/);
  assert.match(oemDesign, /OR-4 \(resolved 2026-08-23\)/);
  assert.match(productionPlan, /PD-6 \(resolved 2026-08-23\)/);
  assert.match(deploymentDesign, /PD-6 \(resolved 2026-08-23\)/);
});
