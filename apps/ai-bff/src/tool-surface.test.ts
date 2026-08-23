import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { ToolSurface } from '@vibelingan-channel/ai-engine-anythingllm';
import { assertNoToolSurface } from './tool-surface.ts';

const surface = (partial: Partial<ToolSurface>): ToolSurface => ({
  known: true,
  enabled: false,
  detail: 'no agent surface',
  ...partial,
});

test('known and disabled: serves', async () => {
  await assertNoToolSurface(async () => surface({ known: true, enabled: false }));
});

test('known and enabled: refuses, and names which surface', async () => {
  await assert.rejects(
    () =>
      assertNoToolSurface(async () =>
        surface({ known: true, enabled: true, detail: 'agentProvider=openai' }),
      ),
    /agentProvider=openai/,
  );
});

test('unknown: refuses rather than serving with capabilities unverified', async () => {
  // This used to warn and start. The zero-tool contract was therefore enforced
  // only when the inspection happened to succeed, which is not a control — an
  // unreachable endpoint served chat with the engine's capabilities unknown.
  await assert.rejects(
    () =>
      assertNoToolSurface(async () =>
        surface({ known: false, enabled: false, detail: 'workspace could not be inspected' }),
      ),
    /could not be verified/,
  );
});

test('the refusal explains the consequence, not just the rule', async () => {
  await assert.rejects(
    () => assertNoToolSurface(async () => surface({ known: false })),
    /zero tool calls/,
  );
});

test('an inspection that throws does not start the service either', async () => {
  await assert.rejects(() =>
    assertNoToolSurface(async () => {
      throw new Error('network down');
    }),
  );
});
