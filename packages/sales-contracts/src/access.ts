export class SalesAccessDenied extends Error {
  constructor() {
    super('Sales access denied');
    this.name = 'SalesAccessDenied';
  }
}

export interface AccessScope {
  client_id: string;
  business_line: string;
  source_installation_id: string;
  runtime_id: string;
  environment: 'test' | 'production';
  control_epoch: number;
}

export interface AccessRequest {
  connection_id: string;
  bearer_token: string;
  action: string;
  scope: AccessScope;
  sender_id?: string;
  inbox_id?: string;
  recipients?: { to: string[]; cc: string[]; bcc: string[] };
}

export interface AccessGrant extends AccessScope {
  actor_id: string;
  connection_id: string;
  knowledge_scope_ref: string;
  resend_team_id: string;
  resend_inbox_id: string;
}

export interface AccessDependencies {
  loadRegistry(): Promise<unknown>;
  loadCredential(ref: string): Promise<string | undefined>;
}

export class SalesAccessController {
  constructor(private readonly dependencies: AccessDependencies) {}

  private async resolve(request: AccessRequest): Promise<AccessGrant> {
    try {
      const registry = validateRegistry(await this.dependencies.loadRegistry());
      const binding = registry.bindings.find((item) =>
        item.connections.some((connection) => connection.connection_id === request.connection_id),
      );
      const connection = binding?.connections.find(
        (item) => item.connection_id === request.connection_id,
      );
      if (!binding || !connection || !binding.active || !connection.active)
        throw new SalesAccessDenied();
      const expected = await this.dependencies.loadCredential(connection.credential_ref);
      if (
        !validCredential(expected) ||
        !validCredential(request.bearer_token) ||
        !timingSafeEqual(digest(expected), digest(request.bearer_token))
      )
        throw new SalesAccessDenied();
      const latest = validateRegistry(await this.dependencies.loadRegistry());
      if (hashCanonicalJson(latest) !== hashCanonicalJson(registry)) throw new SalesAccessDenied();
      const scope = request.scope;
      if (
        !scope ||
        scope.client_id !== binding.client_id ||
        scope.source_installation_id !== binding.source_installation_id ||
        scope.runtime_id !== binding.runtime_id ||
        scope.environment !== binding.environment ||
        scope.control_epoch !== binding.control_epoch ||
        !binding.business_lines.includes(scope.business_line) ||
        !connection.actions.some((action) => action === request.action)
      )
        throw new SalesAccessDenied();
      const safetyStop = request.action === 'task.pause' || request.action === 'task.takeover';
      if ((!registry.enabled || binding.automation_mode === 'disabled') && !safetyStop)
        throw new SalesAccessDenied();
      if (
        connection.actor.kind === 'runtime' &&
        (connection.actor.id !== binding.runtime_id ||
          !['inquiry.read', 'product.read', 'asset.read', 'artifact.write'].includes(
            request.action,
          ))
      )
        throw new SalesAccessDenied();
      if (
        connection.actor.kind === 'operator' &&
        !binding.permitted_operator_ids.includes(connection.actor.id)
      )
        throw new SalesAccessDenied();
      if (connection.actor.kind === 'publisher' && request.action !== 'mail.send')
        throw new SalesAccessDenied();
      if (
        [
          'mail.approve',
          'task.pause',
          'task.takeover',
          'task.resume',
          'connection.manage',
        ].includes(request.action) &&
        connection.actor.kind !== 'operator'
      )
        throw new SalesAccessDenied();
      if (
        ['mail.approve', 'mail.send'].includes(request.action) &&
        !['test_sending', 'approval_required'].includes(binding.automation_mode)
      )
        throw new SalesAccessDenied();
      if (request.action === 'mail.send') {
        if (
          connection.actor.kind !== 'publisher' ||
          !request.sender_id ||
          !binding.allowed_sender_ids.includes(request.sender_id) ||
          request.inbox_id !== binding.resend_inbox_id
        )
          throw new SalesAccessDenied();
        const recipients = request.recipients;
        if (
          !recipients ||
          !Array.isArray(recipients.to) ||
          !Array.isArray(recipients.cc) ||
          !Array.isArray(recipients.bcc) ||
          !recipients.to.length
        )
          throw new SalesAccessDenied();
        const addresses = [...recipients.to, ...recipients.cc, ...recipients.bcc].map(
          normalizeAddress,
        );
        if (addresses.length > 100 || new Set(addresses).size !== addresses.length)
          throw new SalesAccessDenied();
        if (
          binding.automation_mode === 'test_sending' &&
          addresses.some(
            (address) => !binding.test_recipient_allowlist.map(normalizeAddress).includes(address),
          )
        )
          throw new SalesAccessDenied();
      }
      return Object.freeze({
        client_id: binding.client_id,
        business_line: scope.business_line,
        source_installation_id: binding.source_installation_id,
        runtime_id: binding.runtime_id,
        environment: binding.environment,
        control_epoch: binding.control_epoch,
        actor_id: connection.actor.id,
        connection_id: connection.connection_id,
        knowledge_scope_ref: binding.knowledge_scope_ref,
        resend_team_id: binding.resend_team_id,
        resend_inbox_id: binding.resend_inbox_id,
      });
    } catch {
      throw new SalesAccessDenied();
    }
  }

  async execute<T>(
    request: AccessRequest,
    operation: (grant: AccessGrant) => Promise<T>,
  ): Promise<T> {
    const input: AccessRequest = JSON.parse(canonicalizeJson(request));
    const grant = await this.resolve(input);
    const result = await operation(grant);
    if (input.action.endsWith('.read')) await this.resolve(input);
    return result;
  }
}
import { createHash, timingSafeEqual } from 'node:crypto';
import { canonicalizeJson, hashCanonicalJson, validateContract } from './index.ts';
import type { ClientBindings } from './types.generated.ts';

function validCredential(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,512}$/.test(value);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function normalizeAddress(value: string): string {
  return value.trim().replace(/@([^@]+)$/, (_, domain: string) => `@${domain.toLowerCase()}`);
}

function validateRegistry(input: unknown): ClientBindings {
  const registry = validateContract('client-bindings', input);
  const connections = new Set<string>();
  const clients = new Set<string>();
  const ownership = new Map<string, string>();
  for (const binding of registry.bindings) {
    const clientKey = `${binding.environment}:${binding.client_id}`;
    if (clients.has(clientKey)) throw new SalesAccessDenied();
    clients.add(clientKey);
    for (const field of [
      'runtime_id',
      'knowledge_scope_ref',
      'resend_team_id',
      'resend_inbox_id',
      'source_installation_id',
      'apollo_workspace_id',
    ] as const) {
      const value = binding[field];
      if (!value) continue;
      const key = `${binding.environment}:${field}:${value}`;
      if (ownership.has(key) && ownership.get(key) !== binding.client_id)
        throw new SalesAccessDenied();
      ownership.set(key, binding.client_id);
    }
    for (const [provider, ref] of Object.entries(binding.credential_refs)) {
      const key = `${binding.environment}:credential:${provider}:${ref}`;
      if (ownership.has(key) && ownership.get(key) !== binding.client_id)
        throw new SalesAccessDenied();
      ownership.set(key, binding.client_id);
    }
    for (const connection of binding.connections) {
      if (connections.has(connection.connection_id)) throw new SalesAccessDenied();
      connections.add(connection.connection_id);
      const key = `connection_credential:${connection.credential_ref}`;
      if (ownership.has(key)) throw new SalesAccessDenied();
      ownership.set(key, binding.client_id);
    }
  }
  return registry;
}
