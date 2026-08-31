const CAPABILITY_FIELD = /(agent|tool|skill|mcp|plugin|function|action)/i;

// Exact top-level shape observed from both `/api/v1/workspaces` and the
// selected hosted fork's `/api/v1/workspace/{slug}` on 2026-08-31. A new field
// is not assumed passive: startup stops until someone reviews and adds it.
const REVIEWED_WORKSPACE_FIELDS = new Set([
  'agentModel',
  'agentProvider',
  'chatMode',
  'chatModel',
  'chatProvider',
  'createdAt',
  'documents',
  'id',
  'lastUpdatedAt',
  'name',
  'openAiHistory',
  'openAiPrompt',
  'openAiTemp',
  'pfpFilename',
  'queryRefusalResponse',
  'router_id',
  'similarityThreshold',
  'slug',
  'threads',
  'topN',
  'vectorSearchMode',
  'vectorTag',
]);

const REVIEWED_DOCUMENT_FIELDS = new Set([
  'createdAt',
  'docId',
  'docpath',
  'filename',
  'id',
  'lastUpdatedAt',
  'metadata',
  'pinned',
  'watched',
  'workspaceId',
]);
const REVIEWED_THREAD_FIELDS = new Set(['slug', 'user_id']);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unreviewedWorkspaceChildren(workspace) {
  const failures = [];
  const inspect = (name, allowed) => {
    const collection = workspace[name];
    if (collection === undefined || collection === null) return;
    if (!Array.isArray(collection)) {
      failures.push(`${name} (not an array)`);
      return;
    }
    collection.forEach((entry, index) => {
      if (!isRecord(entry)) {
        failures.push(`${name}[${index}] (not an object)`);
        return;
      }
      for (const field of Object.keys(entry)) {
        if (!allowed.has(field)) failures.push(`${name}[${index}].${field}`);
      }
    });
  };
  inspect('documents', REVIEWED_DOCUMENT_FIELDS);
  inspect('threads', REVIEWED_THREAD_FIELDS);
  return failures.sort();
}

function hasEnabledValue(value) {
  if (value === null || value === undefined || value === false || value === '' || value === 0) {
    return false;
  }
  if (Array.isArray(value)) return value.some(hasEnabledValue);
  if (isRecord(value)) return Object.values(value).some(hasEnabledValue);
  return true;
}

/**
 * Enumerate every capability-shaped field exposed by the workspace response,
 * including fork-specific nested tool/skill fields. The protocol has no
 * mid-stream tool-call frame, so an enabled field we did not enumerate would
 * bypass maxToolCalls=0. Values are deliberately not returned or logged.
 */
function enabledCapabilityPaths(value) {
  const paths = [];
  const visit = (record, prefix) => {
    for (const [key, child] of Object.entries(record)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (CAPABILITY_FIELD.test(key) && hasEnabledValue(child)) paths.push(path);
      if (isRecord(child)) visit(child, path);
      if (Array.isArray(child)) {
        child.forEach((entry, index) => {
          if (isRecord(entry)) visit(entry, `${path}[${index}]`);
        });
      }
    }
  };
  visit(value, '');
  return [...new Set(paths)].sort();
}

/**
 * Inspect the exact workspace response shape shared by the runtime and the
 * deployment probe. This file is plain ESM so the pinned Node 22 probe can
 * execute it directly without a TypeScript loader.
 *
 * @param {unknown} body
 * @returns {{known: boolean, enabled: boolean, detail: string}}
 */
export function inspectWorkspaceToolSurface(body) {
  const workspaceValue = isRecord(body) ? body.workspace : undefined;
  const workspace = Array.isArray(workspaceValue)
    ? isRecord(workspaceValue[0])
      ? workspaceValue[0]
      : null
    : isRecord(workspaceValue)
      ? workspaceValue
      : null;
  if (!workspace) {
    return { known: false, enabled: false, detail: 'workspace shape could not be verified' };
  }
  const unreviewedFields = Object.keys(workspace)
    .filter((field) => !REVIEWED_WORKSPACE_FIELDS.has(field))
    .sort();
  if (unreviewedFields.length > 0) {
    return {
      known: false,
      enabled: false,
      detail: `unreviewed workspace fields: ${unreviewedFields.join(', ')}`,
    };
  }
  const unreviewedNested = unreviewedWorkspaceChildren(workspace);
  if (unreviewedNested.length > 0) {
    return {
      known: false,
      enabled: false,
      detail: `unreviewed nested workspace fields: ${unreviewedNested.join(', ')}`,
    };
  }
  const enabledPaths = enabledCapabilityPaths(workspace);
  const enabled = enabledPaths.length > 0;
  return {
    known: true,
    enabled,
    detail: enabled ? `enabled capability fields: ${enabledPaths.join(', ')}` : 'no tool surface',
  };
}
