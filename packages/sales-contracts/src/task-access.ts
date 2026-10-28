import { hashCanonicalJson, validateContract } from './index.ts';
import type { TaskPermit, TaskReadRequest } from './types.generated.ts';

export class TaskAccessDenied extends Error {
  constructor() {
    super('Sales task access denied');
    this.name = 'TaskAccessDenied';
  }
}

const SCOPE = ['client_id', 'business_line', 'source_installation_id', 'environment'] as const;
const TASK = [...SCOPE, 'runtime_id', 'control_epoch', 'task_id', 'run_id', 'task_revision', 'handoff_sha256'] as const;

/** Inputs must come from authenticated server stores/transport, never model claims. */
export function authorizeTaskRead(
  leaseValue: unknown, handoffValue: unknown, permitValue: unknown, requestValue: unknown, now: number,
): TaskReadRequest {
  try {
    clock(now);
    const lease = validateContract('sales-auth-lease', leaseValue);
    const handoff = validateContract('sales-auth-handoff', handoffValue);
    const permit = validateContract('sales-auth-permit', permitValue);
    const request = validateContract('sales-auth-request', requestValue);
    for (const key of [...TASK, 'connection_id', 'lease_sha256'] as const)
      requireMatch(lease[key], request[key]);
    for (const key of [...SCOPE, 'handoff_sha256'] as const)
      requireMatch(lease[key], handoff[key]);
    requireMatch(hashCanonicalJson(lease.source), hashCanonicalJson(handoff.source));
    if (handoff.state !== 'ready' || handoff.created_at > lease.issued_at || lease.revoked)
      throw new TaskAccessDenied();
    window(lease.issued_at, lease.expires_at, now, 300);
    window(permit.issued_at, permit.expires_at, now, 10);
    requireMatch(permit.request_sha256, hashCanonicalJson(request));
    if (!lease.allowed_actions.includes(request.action)) throw new TaskAccessDenied();
    if (request.action === 'inquiry.read' &&
      (request.resource.kind !== lease.source.kind || request.resource.id !== lease.source.id))
      throw new TaskAccessDenied();
    if (request.action === 'asset.read' && !lease.asset_refs.includes(request.resource.ref))
      throw new TaskAccessDenied();
    return request;
  } catch {
    throw new TaskAccessDenied();
  }
}

/** The caller must load current task state and authenticate the requesting service. */
export function issueTaskPermit(requestValue: unknown, authorityValue: unknown, now: number): TaskPermit {
  try {
    clock(now);
    if (!Number.isSafeInteger(now + 10)) throw new TaskAccessDenied();
    const request = validateContract('sales-auth-request', requestValue);
    const authority = validateContract('sales-auth-authority', authorityValue);
    for (const key of TASK) requireMatch(authority[key], request[key]);
    if (!authority.source_verified || authority.mode !== 'agent_active' ||
      authority.work_state !== 'preparing' || !authority.allowed_actions.includes(request.action))
      throw new TaskAccessDenied();
    return { protocol: 'sales-auth/1', allowed: true,
      request_sha256: hashCanonicalJson(request), issued_at: now, expires_at: now + 10 };
  } catch {
    throw new TaskAccessDenied();
  }
}

function requireMatch(left: unknown, right: unknown): void {
  if (left !== right) throw new TaskAccessDenied();
}
function clock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new TaskAccessDenied();
}
function window(start: number, end: number, now: number, max: number): void {
  if (start > now || end <= now || end <= start || end - start > max)
    throw new TaskAccessDenied();
}
