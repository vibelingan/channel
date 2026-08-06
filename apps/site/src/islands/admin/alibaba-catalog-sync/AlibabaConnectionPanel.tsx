/**
 * Connection lifecycle panel (MIU 13). Purely presentational: the page
 * container owns data + actions. Secret-free by construction — the API view
 * is already redacted server-side.
 */
import type { ConnectionStatus } from './alibaba-api.ts';

export interface AlibabaConnectionPanelProps {
  status: ConnectionStatus | null;
  loading: boolean;
  busy: boolean;
  notice: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onRunNow: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  not_connected: 'Not connected',
  active: 'Connected',
  authorization_expired: 'Authorization expired — reconnect required',
  disconnected: 'Disconnected',
};

export function AlibabaConnectionPanel({
  status,
  loading,
  busy,
  notice,
  onConnect,
  onDisconnect,
  onRunNow,
}: AlibabaConnectionPanelProps) {
  if (loading) {
    return (
      <div data-alibaba-connection className="rounded-lg border border-slate-200 bg-white p-5">
        <p className="text-sm text-slate-500">Loading connection status…</p>
      </div>
    );
  }
  const state = status?.status ?? 'not_connected';
  const connected = state === 'active';
  return (
    <div data-alibaba-connection className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-slate-900">Alibaba connection</h3>
          <p className="mt-1 text-sm text-slate-600" data-connection-state={state}>
            {STATUS_LABELS[state] ?? state}
            {status?.accountLabel ? ` — ${status.accountLabel}` : ''}
          </p>
          {connected && status?.accessTokenExpiresAt && (
            <p className="mt-0.5 text-xs text-slate-500">
              Access token valid until {status.accessTokenExpiresAt.slice(0, 16).replace('T', ' ')}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {connected ? (
            <>
              <button
                type="button"
                data-run-now
                disabled={busy}
                onClick={onRunNow}
                className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Run sync now
              </button>
              <button
                type="button"
                data-disconnect
                disabled={busy}
                onClick={onDisconnect}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 disabled:opacity-50"
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              type="button"
              data-connect
              disabled={busy || status?.notConfigured === true}
              onClick={onConnect}
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Connect Alibaba account
            </button>
          )}
        </div>
      </div>
      {status?.notConfigured === true && (
        <p
          data-not-configured
          className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800"
        >
          Not configured in this environment. Missing: {(status.missing ?? []).join(', ')}
        </p>
      )}
      {notice && (
        <p
          data-connection-notice
          className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-700"
        >
          {notice}
        </p>
      )}
    </div>
  );
}
