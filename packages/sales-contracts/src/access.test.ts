import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { type AccessRequest, SalesAccessController, SalesAccessDenied } from './access.ts';

function setup() {
  const registry = JSON.parse(
    readFileSync(new URL('../fixtures/client-bindings.json', import.meta.url), 'utf8'),
  );
  let calls = 0;
  const secrets: Record<string, string | undefined> = {
    'env:AGENT_a': 'a'.repeat(48),
    'env:AGENT_b': 'b'.repeat(48),
    'env:SALES_a': 'c'.repeat(48),
    'env:SALES_b': 'd'.repeat(48),
  };
  const access = new SalesAccessController({
    loadRegistry: async () => structuredClone(registry),
    loadCredential: async (ref) => secrets[ref],
  });
  const request = (letter = 'a'): AccessRequest => ({
    connection_id: `agent_${letter}`,
    bearer_token: letter.repeat(48),
    action: 'inquiry.read',
    scope: {
      client_id: `client_${letter}`,
      business_line: 'website_sales',
      source_installation_id: `site_${letter}`,
      runtime_id: `runtime_${letter}`,
      environment: 'test',
      control_epoch: 1,
    },
  });
  const tool = async (grant: { client_id: string }) => {
    calls++;
    return `canary_${grant.client_id}`;
  };
  return { registry, secrets, access, request, tool, calls: () => calls };
}

test('each authenticated connection reaches only its own scoped tool target', async () => {
  const s = setup();
  assert.equal(await s.access.execute(s.request(), s.tool), 'canary_client_a');
  assert.equal(await s.access.execute(s.request('b'), s.tool), 'canary_client_b');
  assert.equal(s.calls(), 2);
});

test('client_a_cannot_read_or_send_for_b', async () => {
  const s = setup();
  for (const action of ['inquiry.read', 'mail.send']) {
    await assert.rejects(
      s.access.execute({ ...s.request(), action, scope: s.request('b').scope }, s.tool),
      SalesAccessDenied,
    );
  }
  assert.equal(s.calls(), 0);
});

test('unbound connection, malformed credentials and secret lookup failure have no default client', async () => {
  const s = setup();
  for (const patch of [
    { connection_id: 'missing' },
    { bearer_token: '' },
    { bearer_token: 'wrong'.repeat(10) },
  ]) {
    await assert.rejects(s.access.execute({ ...s.request(), ...patch }, s.tool), SalesAccessDenied);
  }
  s.secrets['env:AGENT_a'] = undefined;
  await assert.rejects(s.access.execute(s.request(), s.tool), SalesAccessDenied);
  assert.equal(s.calls(), 0);
});

test('wrong business, installation, runtime, environment or control epoch cannot reach tools', async () => {
  const s = setup();
  for (const patch of [
    { business_line: 'cold_outreach' },
    { source_installation_id: 'site_b' },
    { runtime_id: 'runtime_b' },
    { environment: 'production' as const },
    { control_epoch: 0 },
  ]) {
    await assert.rejects(
      s.access.execute({ ...s.request(), scope: { ...s.request().scope, ...patch } }, s.tool),
      SalesAccessDenied,
    );
  }
  assert.equal(s.calls(), 0);
});

test('revoked connection, client and global kill switch block the next dispatch', async () => {
  for (const change of [
    (r: ReturnType<typeof setup>['registry']) => {
      r.bindings[0].connections[0].active = false;
    },
    (r: ReturnType<typeof setup>['registry']) => {
      r.bindings[0].active = false;
    },
    (r: ReturnType<typeof setup>['registry']) => {
      r.enabled = false;
    },
    (r: ReturnType<typeof setup>['registry']) => {
      r.bindings[0].control_epoch++;
    },
  ]) {
    const s = setup();
    await s.access.execute(s.request(), s.tool);
    change(s.registry);
    await assert.rejects(s.access.execute(s.request(), s.tool), SalesAccessDenied);
    assert.equal(s.calls(), 1);
  }
});

test('agent cannot approve even when its action list is misconfigured', async () => {
  const s = setup();
  s.registry.bindings[0].connections[0].actions.push('mail.approve');
  s.registry.bindings[0].automation_mode = 'approval_required';
  await assert.rejects(
    s.access.execute({ ...s.request(), action: 'mail.approve' }, s.tool),
    SalesAccessDenied,
  );
  assert.equal(s.calls(), 0);
});

test('mapped operator may pause disabled automation but cannot impersonate another operator', async () => {
  const s = setup();
  s.registry.bindings[0].automation_mode = 'disabled';
  const request = {
    ...s.request(),
    connection_id: 'sales_a',
    bearer_token: 'c'.repeat(48),
    action: 'task.pause',
  };
  assert.equal(await s.access.execute(request, s.tool), 'canary_client_a');
  s.registry.bindings[0].permitted_operator_ids = ['sales_b'];
  await assert.rejects(s.access.execute(request, s.tool), SalesAccessDenied);
  assert.equal(s.calls(), 1);
});

test('duplicate connection or cross-client runtime and provider binding is rejected', async () => {
  for (const field of [
    'runtime_id',
    'knowledge_scope_ref',
    'resend_team_id',
    'resend_inbox_id',
    'source_installation_id',
  ]) {
    const s = setup();
    s.registry.bindings[1][field] = s.registry.bindings[0][field];
    await assert.rejects(s.access.execute(s.request(), s.tool), SalesAccessDenied);
    assert.equal(s.calls(), 0);
  }
  const s = setup();
  s.registry.bindings[1].connections[0].connection_id = 'agent_a';
  await assert.rejects(s.access.execute(s.request(), s.tool), SalesAccessDenied);
});

test('registry and credential resolver failures deny without leaking their error text', async () => {
  const s = setup();
  for (const stage of ['registry', 'credential']) {
    const access = new SalesAccessController({
      loadRegistry: async () => {
        if (stage === 'registry') throw new Error('sensitive-config');
        return s.registry;
      },
      loadCredential: async () => {
        throw new Error('sensitive-key');
      },
    });
    await assert.rejects(
      access.execute(s.request(), s.tool),
      (error: unknown) =>
        error instanceof SalesAccessDenied && error.message === 'Sales access denied',
    );
  }
});

test('credentials and other clients never appear in a grant', async () => {
  const s = setup();
  const grant = await s.access.execute(s.request(), async (g) => g);
  assert.equal(grant.client_id, 'client_a');
  assert.ok(!JSON.stringify(grant).includes('env:'));
  assert.ok(!JSON.stringify(grant).includes('client_b'));
});

test('publisher permission binds sender, inbox and every test recipient category', async () => {
  const s = setup();
  s.registry.bindings[0].automation_mode = 'test_sending';
  s.registry.bindings[0].connections.push({
    connection_id: 'publisher_a',
    credential_ref: 'env:PUBLISHER_a',
    active: true,
    actor: { kind: 'publisher', id: 'publisher_a' },
    actions: ['mail.send', 'inquiry.read'],
  });
  s.secrets['env:PUBLISHER_a'] = 'p'.repeat(48);
  const request: AccessRequest = {
    ...s.request(),
    connection_id: 'publisher_a',
    bearer_token: 'p'.repeat(48),
    action: 'mail.send',
    sender_id: 'sender_a',
    inbox_id: 'inbox_a',
    recipients: { to: ['test@example.invalid'], cc: [], bcc: [] },
  };
  assert.equal(await s.access.execute(request, s.tool), 'canary_client_a');
  for (const patch of [
    { sender_id: 'sender_b' },
    { inbox_id: 'inbox_b' },
    { scope: s.request('b').scope },
    { recipients: { to: ['buyer@example.invalid'], cc: [], bcc: [] } },
    { recipients: { to: ['test@example.invalid'], cc: ['buyer@example.invalid'], bcc: [] } },
    { recipients: { to: ['test@example.invalid'], cc: [], bcc: ['buyer@example.invalid'] } },
    { action: 'inquiry.read' },
  ]) {
    await assert.rejects(s.access.execute({ ...request, ...patch }, s.tool), SalesAccessDenied);
  }
  assert.equal(s.calls(), 1);
});

test('authorization changes during credential lookup or a read discard the result', async () => {
  const s = setup();
  const access = new SalesAccessController({
    loadRegistry: async () => structuredClone(s.registry),
    loadCredential: async () => {
      s.registry.enabled = false;
      return 'a'.repeat(48);
    },
  });
  await assert.rejects(access.execute(s.request(), s.tool), SalesAccessDenied);
  assert.equal(s.calls(), 0);
  s.registry.enabled = true;
  await assert.rejects(
    s.access.execute(s.request(), async () => {
      s.registry.enabled = false;
      return 'sensitive-result';
    }),
    SalesAccessDenied,
  );
});
