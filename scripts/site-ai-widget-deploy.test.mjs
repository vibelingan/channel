/**
 * The website's chat widget only works if the site build is told where the
 * assistant API is. That address is baked into the pages when they are built,
 * so a live-site deploy that forgets it ships a button that can only say
 * "unavailable". These tests keep Deploy Test wired to the address for as long
 * as any page mounts the widget.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { AI_WIDGET_ROUTES } from '../apps/site/src/lib/ai-widget-routes.ts';

const workflow = parseYaml(
  readFileSync(new URL('../.github/workflows/deploy-test.yml', import.meta.url), 'utf8'),
);
const deploy = workflow.jobs?.deploy;
const stepIndex = (name) => deploy.steps.findIndex((step) => step.name === name);

test('the widget is still mounted on public pages, so the site build needs its address', () => {
  // If no page mounts the widget any more, delete this file and the wiring together.
  assert.ok(AI_WIDGET_ROUTES.length > 0);
});

test('the live-site build is given the assistant API address from the test environment', () => {
  assert.match(
    String(deploy.env?.PUBLIC_AI_API_BASE_URL ?? ''),
    /^\$\{\{ vars\.PUBLIC_AI_API_BASE_URL \}\}$/,
  );
});

test('a site build without a working assistant address never reaches the live site', () => {
  const build = stepIndex('Build site');
  const check = stepIndex('Check the built site can reach the AI assistant');
  const release = stepIndex('Deploy to CloudBase test');
  assert.ok(build >= 0 && check >= 0 && release >= 0, 'expected build, check and deploy steps');
  assert.ok(build < check, 'the check must inspect the finished build');
  assert.ok(check < release, 'the check must run before the site is deployed');
  const script = deploy.steps[check].run;
  assert.match(script, /https:\/\/\*\)/, 'the address must be https');
  assert.match(
    script,
    /grep -R -q -F "\$PUBLIC_AI_API_BASE_URL" apps\/site\/dist/,
    'the built files must contain the address',
  );
});
