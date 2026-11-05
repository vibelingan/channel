import assert from 'node:assert/strict';
import { readCompleteFunctionInventory } from './function-inventory.mjs';
import { SITE_DELIVERY_POLICY as policy } from './site-policy.mjs';

export function assertStoppedCatalogReceipt(receipt, context) {
  assert.equal(receipt?.schemaVersion, 1);
  assert.equal(receipt.purpose, 'catalog-seo-regional-v1');
  assert.equal(receipt.runId, context.runId);
  assert.equal(receipt.codeSha, context.codeSha);
  assert.equal(
    receipt.functionName,
    `seo-catalog-region-${context.githubRunId}-${context.attempt}`,
  );
  assert.equal(receipt.environment, policy.envId);
  assert.equal(receipt.created, true);
  assert.equal(receipt.cleaned, true);
  assert.equal(receipt.unconfirmed, false);
  assert.equal(receipt.websiteWrites, 0);
  assert.equal(receipt.businessWrites, 0);
  assert.ok(
    Array.isArray(receipt.calls) && receipt.calls.length > 0 && receipt.calls.length <= 50000,
  );
  const allowed = new Set([
    'health',
    'seed',
    'prepare.step',
    'recovery.clear',
    'delivery.begin',
    'delivery.end',
  ]);
  for (const call of receipt.calls) {
    assert.ok(allowed.has(call?.action));
    assert.ok(['completed', 'readback-confirmed'].includes(call.state));
    assert.match(call.requestId ?? '', /^[A-Za-z0-9:_-]{1,200}$/);
  }
  assert.ok(receipt.calls.some((call) => call.action === 'health'));
  assert.ok(receipt.calls.some((call) => call.action === 'delivery.end'));
}

export async function assertStoppedFunctionsAbsent(functions, names) {
  const found = new Set(await readCompleteFunctionInventory(functions, policy.envId));
  for (const name of names) assert.ok(!found.has(name), `Stopped worker still exists: ${name}`);
}
