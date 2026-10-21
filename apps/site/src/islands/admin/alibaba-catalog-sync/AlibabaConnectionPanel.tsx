import type { AlibabaSyncWorkflow } from '@vibelingan-channel/shared';
import type { ConnectionStatus } from './alibaba-api.ts';
export interface AlibabaConnectionPanelProps {
  status: ConnectionStatus | null;
  workflow?: AlibabaSyncWorkflow | null;
  loading: boolean;
  busy: boolean;
  notice: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onRunNow: () => void;
}
const phaseText: Record<AlibabaSyncWorkflow['phase'], string> = {
  idle: 'Sync products from Alibaba into unpublished drafts.',
  queued: 'Sync requested. It will continue automatically; you can leave this page.',
  syncing: 'Syncing product data. Progress is saved; you can leave this page.',
  preparing: 'Preparing and checking products automatically. You can leave this page.',
  waiting: 'Waiting to retry supplier requests automatically. Your progress is saved.',
  complete:
    'Sync complete. Review products and their website categories in Products before publishing.',
  attention: 'Sync needs attention. Existing products and your edits are kept.',
};
const issueText: Record<NonNullable<AlibabaSyncWorkflow['issue']>, string> = {
  'supplier-data':
    'Alibaba returned data that could not be accepted safely. Check the supplier listings, then retry sync. Contact the site administrator if this continues.',
  'supplier-unavailable':
    'Alibaba could not finish the request. Check the account connection, then retry sync.',
  photos:
    'Some supplier photos are unavailable. Review the affected products and image links below, then retry or replace the images.',
  preparation:
    'Some product drafts could not be prepared. Retry sync; contact the site administrator if this continues.',
  'run-expired': 'The previous sync stopped before finishing. Retry sync to restart safely.',
};
export function AlibabaConnectionPanel({
  status,
  workflow,
  loading,
  busy,
  notice,
  onConnect,
  onDisconnect,
  onRunNow,
}: AlibabaConnectionPanelProps) {
  const connected = status?.status === 'active';
  const running =
    workflow && ['queued', 'syncing', 'preparing', 'waiting'].includes(workflow.phase);
  const reconnect = status?.status === 'authorization_expired';
  return (
    <section data-alibaba-connection className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Alibaba products</h2>
          <p
            className="mt-1 text-sm text-slate-600"
            data-connection-state={status?.status ?? 'not_connected'}
          >
            {loading
              ? 'Loading connection status…'
              : connected
                ? `Connected${status?.accountLabel ? ` · ${status.accountLabel}` : ''}`
                : reconnect
                  ? 'Authorization expired. Reconnect to continue.'
                  : 'Not connected'}
          </p>
        </div>
        {connected ? (
          <button
            type="button"
            data-run-now
            disabled={busy || running === true || workflow?.enabled !== true}
            onClick={onRunNow}
            className="min-h-11 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy
              ? 'Starting…'
              : running
                ? 'Syncing…'
                : workflow?.phase === 'attention'
                  ? 'Retry sync'
                  : 'Sync products'}
          </button>
        ) : (
          <button
            type="button"
            data-connect
            disabled={loading || busy || status?.notConfigured === true}
            onClick={onConnect}
            className="min-h-11 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {reconnect ? 'Reconnect Alibaba account' : 'Connect Alibaba account'}
          </button>
        )}
      </div>
      {workflow && (
        <output
          data-sync-progress
          aria-live="polite"
          className="mt-4 block border-t border-slate-100 pt-4"
        >
          <p className="text-sm text-slate-800">{phaseText[workflow.phase]}</p>
          {workflow.runId && (
            <p className="mt-2 text-sm text-slate-600">
              {workflow.processed.toLocaleString('en-US')} products processed
            </p>
          )}
          {workflow.issue && (
            <p className="mt-2 text-sm text-amber-800">
              {issueText[workflow.issue]}
              {workflow.photoIssues > 0
                ? ` ${workflow.photoIssues} products need photo review.`
                : ''}
            </p>
          )}
        </output>
      )}
      {status?.notConfigured === true && (
        <p data-not-configured className="mt-3 text-sm text-amber-800">
          The Alibaba connection is not available. Contact the site administrator.
        </p>
      )}
      {workflow?.enabled === false && (
        <p className="mt-3 text-sm text-amber-800">
          The background sync service is unavailable. Contact the site administrator.
        </p>
      )}
      {notice && (
        <output
          data-connection-notice
          aria-live="polite"
          className="mt-3 block rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {notice}
        </output>
      )}
      {connected && (
        <details className="mt-4 text-sm text-slate-600">
          <summary className="cursor-pointer">Connection settings</summary>
          <p className="mt-2">Disconnecting keeps existing website products.</p>
          <button
            type="button"
            data-disconnect
            disabled={busy || running === true}
            onClick={onDisconnect}
            className="mt-2 min-h-11 rounded-lg border border-slate-300 px-3 py-2 disabled:opacity-50"
          >
            Disconnect account
          </button>
        </details>
      )}
    </section>
  );
}
