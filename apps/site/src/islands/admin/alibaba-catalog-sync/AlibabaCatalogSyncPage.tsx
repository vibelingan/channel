import { useQueryClient } from '@tanstack/react-query';
import type { AlibabaSyncWorkflow } from '@vibelingan-channel/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlibabaConnectionPanel } from './AlibabaConnectionPanel.tsx';
import { AlibabaPhotoIssues } from './AlibabaPhotoIssues.tsx';
import { AlibabaSyncRunTable } from './AlibabaSyncRunTable.tsx';
import {
  type ConnectionStatus,
  disconnectAlibaba,
  fetchConnectionStatus,
  fetchSyncWorkflow,
  startOAuthFlow,
  startSync,
} from './alibaba-api.ts';

const CHECKING_SAVED_SYNC =
  'The sync request was not confirmed. Checking saved progress automatically.';
const GENERIC_CALLBACK_NOTICE = 'Authorization failed. Start the flow again.';

// A Map, NOT an object literal (review R2-verify): `?alibaba=__proto__` on a
// plain object resolves through Object.prototype, so the `??` fallback never
// fires and a non-string lands in React's children — blanking the whole
// dashboard island. Map lookups see own entries only.
const CALLBACK_NOTICES = new Map<string, string>([
  ['connected', 'Alibaba account connected successfully.'],
  ['rate-limited', 'Too many authorization attempts — try again shortly.'],
  ['not-configured', 'The Alibaba connection is not configured on the server.'],
  [
    'error-missing-params',
    'Authorization failed: the callback was incomplete. Start the flow again.',
  ],
  [
    'error-replayed-state',
    'Authorization failed: this link was already used. Start the flow again.',
  ],
  ['error-unknown-state', 'Authorization failed: unrecognized request. Start the flow again.'],
  ['error-expired-state', 'Authorization failed: the request expired. Start the flow again.'],
  ['error-exchange-failed', 'Authorization failed at the token exchange. Start the flow again.'],
]);

export function callbackNotice(search: string): string | null {
  const value = new URLSearchParams(search).get('alibaba');
  if (!value) return null;
  return CALLBACK_NOTICES.get(value) ?? GENERIC_CALLBACK_NOTICE;
}

export interface AlibabaCatalogSyncPageProps {
  onViewProducts?: () => void;
  onOpenProduct?: (id: string) => void;
}
export function AlibabaCatalogSyncPage({
  onViewProducts,
  onOpenProduct,
}: AlibabaCatalogSyncPageProps) {
  const queryClient = useQueryClient();
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [workflow, setWorkflow] = useState<AlibabaSyncWorkflow | null>(null);
  const [photoReview, setPhotoReview] = useState<{ runId: string | null; count: number } | null>(
    null,
  );
  const onPhotoCount = useCallback(
    (count: number) => setPhotoReview({ runId: workflow?.runId ?? null, count }),
    [workflow?.runId],
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(
    typeof window === 'undefined' ? null : callbackNotice(window.location.search),
  );
  const generation = useRef(0);
  const mounted = useRef(false);
  const mutating = useRef(false);
  const refresh = useCallback(async () => {
    if (mutating.current) return null;
    const epoch = ++generation.current;
    try {
      const [nextConnection, nextWorkflow] = await Promise.all([
        fetchConnectionStatus(),
        fetchSyncWorkflow(),
      ]);
      if (!mounted.current || epoch !== generation.current) return null;
      setConnection(nextConnection);
      setWorkflow(nextWorkflow);
      setNotice((previous) =>
        previous ===
          'Connection interrupted. Saved sync progress is kept; checking again automatically.' ||
        (previous === CHECKING_SAVED_SYNC &&
          ['queued', 'syncing', 'preparing', 'waiting'].includes(nextWorkflow.phase))
          ? null
          : previous,
      );
      return nextWorkflow;
    } catch {
      if (mounted.current && epoch === generation.current)
        setNotice(
          'Connection interrupted. Saved sync progress is kept; checking again automatically.',
        );
      return null;
    } finally {
      if (mounted.current && epoch === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const current = await refresh();
      if (!closed)
        timer = setTimeout(
          poll,
          !current || ['queued', 'syncing', 'preparing', 'waiting'].includes(current.phase)
            ? 5000
            : 30000,
        );
    };
    void poll();
    return () => {
      closed = true;
      mounted.current = false;
      generation.current++;
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);
  const action = async (operation: () => Promise<void>, syncRequest = false) => {
    if (mutating.current) return;
    mutating.current = true;
    generation.current++;
    setBusy(true);
    setNotice(null);
    try {
      await operation();
    } catch (error) {
      if (mounted.current)
        setNotice(
          syncRequest
            ? CHECKING_SAVED_SYNC
            : error instanceof Error
              ? error.message
              : 'The request could not be confirmed. Checking saved progress is safe.',
        );
    } finally {
      mutating.current = false;
      if (mounted.current) {
        setBusy(false);
        void refresh();
      }
    }
  };
  const invalidateProducts = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['list', 'products'] });
    void queryClient.invalidateQueries({ queryKey: ['product-review-summary'] });
  }, [queryClient]);
  useEffect(() => {
    if (workflow?.runId && (workflow.phase === 'complete' || workflow.phase === 'attention'))
      invalidateProducts();
  }, [workflow?.phase, workflow?.runId, invalidateProducts]);
  return (
    <div data-alibaba-sync-page className="space-y-5">
      <AlibabaConnectionPanel
        status={connection}
        workflow={
          workflow && photoReview?.runId === workflow.runId
            ? { ...workflow, photoIssues: photoReview.count }
            : workflow
        }
        loading={loading}
        busy={busy}
        notice={notice}
        onConnect={() =>
          void action(async () => {
            const result = await startOAuthFlow();
            window.location.assign(result.authorizeUrl);
          })
        }
        onDisconnect={() => {
          if (confirm('Disconnect the Alibaba account? Existing products are kept.'))
            void action(async () => {
              await disconnectAlibaba();
            });
        }}
        onRunNow={() =>
          void action(async () => {
            const next = await startSync();
            if (mounted.current) setWorkflow(next);
            invalidateProducts();
          }, true)
        }
      />
      {workflow?.photoIssues !== undefined && workflow.photoIssues > 0 && (
        <AlibabaPhotoIssues
          key={workflow.runId}
          onOpenProduct={onOpenProduct}
          onCount={onPhotoCount}
        />
      )}
      {onViewProducts && (
        <button
          type="button"
          onClick={onViewProducts}
          className="min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          View products
        </button>
      )}
      <AlibabaSyncRunTable history={workflow?.history ?? []} />
    </div>
  );
}
