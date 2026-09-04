import type { CollectionDoc } from '@vibelingan-channel/shared';
/**
 * Alibaba Catalog Sync operations page (MIU 13) — the dedicated admin
 * surface for the connection lifecycle, manual runs, run history, quarantine
 * review, and explicit product linking. Category mappings stay a plain
 * generic-CRUD section; the sync-internal collections are readOnly/none and
 * only ever surface through these dedicated actions.
 */
import { useCallback, useEffect, useState } from 'react';
import { listRecords } from '../api.ts';
import { AlibabaConnectionPanel } from './AlibabaConnectionPanel.tsx';
import { AlibabaProductDetailInspection } from './AlibabaProductDetailInspection.tsx';
import { AlibabaProductLinkAction } from './AlibabaProductLinkAction.tsx';
import { AlibabaQuarantineReview } from './AlibabaQuarantineReview.tsx';
import { AlibabaSyncRunTable } from './AlibabaSyncRunTable.tsx';
import {
  type ConnectionStatus,
  type ProductDetailInspectionSummary,
  approveQuarantine,
  disconnectAlibaba,
  fetchConnectionStatus,
  inspectProductDetail,
  linkSourceProduct,
  runSyncNow,
  startOAuthFlow,
  unlinkSourceProduct,
} from './alibaba-api.ts';

/** Reads the ?alibaba= status the OAuth callback redirect carries. */
/**
 * CLOSED status set only (review R2 #12): the query value is
 * attacker-controllable (anyone can craft ?alibaba=...), so nothing from the
 * URL is ever echoed into the page — unknown values collapse to the generic
 * failure line.
 */
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

export function AlibabaCatalogSyncPage() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [runs, setRuns] = useState<CollectionDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(
    typeof window === 'undefined' ? null : callbackNotice(window.location.search),
  );
  const [linkResult, setLinkResult] = useState<string | null>(null);
  const [detailInspection, setDetailInspection] = useState<ProductDetailInspectionSummary | null>(
    null,
  );
  const [inspectingDetail, setInspectingDetail] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextRuns] = await Promise.all([
        fetchConnectionStatus(),
        listRecords({
          collection: 'alibabaSyncRuns',
          page: 1,
          pageSize: 20,
          sort: [{ field: 'startedAt', dir: 'desc' }],
        }),
      ]);
      setStatus(nextStatus);
      setRuns([...nextRuns.items]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to load sync status.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const guard = useCallback(
    async (operation: () => Promise<string | null>) => {
      setBusy(true);
      try {
        const message = await operation();
        if (message !== null) setNotice(message);
        await refresh();
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'The action failed.');
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return (
    <div data-alibaba-sync-page className="space-y-4">
      <AlibabaConnectionPanel
        status={status}
        loading={loading}
        busy={busy}
        notice={notice}
        onConnect={() =>
          void guard(async () => {
            const { authorizeUrl } = await startOAuthFlow();
            window.location.assign(authorizeUrl);
            return 'Redirecting to Alibaba for authorization…';
          })
        }
        onDisconnect={() =>
          void guard(async () => {
            await disconnectAlibaba();
            return 'Connection disconnected; stored tokens destroyed.';
          })
        }
        onRunNow={() =>
          void guard(async () => {
            const report = await runSyncNow();
            return `Sync tick finished: ${report.outcome}${report.runId ? ` (${report.runId})` : ''}.`;
          })
        }
      />
      <AlibabaProductDetailInspection
        connected={status?.status === 'active'}
        busy={busy}
        inspecting={inspectingDetail}
        result={detailInspection}
        onInspect={(sourceProductId) => {
          setInspectingDetail(true);
          void guard(async () => {
            setDetailInspection(null);
            const summary = await inspectProductDetail(sourceProductId);
            setDetailInspection(summary);
            return `Detail inspection completed for ${summary.sourceProductId}.`;
          }).finally(() => setInspectingDetail(false));
        }}
      />
      <AlibabaQuarantineReview
        runs={runs.filter((run) => run.status === 'quarantined')}
        busy={busy}
        onApprove={(runId, candidateHash) =>
          void guard(async () => {
            const result = await approveQuarantine(runId, candidateHash);
            return `Quarantine approved; ${result.promoted} product(s) promoted.`;
          })
        }
      />
      <AlibabaProductLinkAction
        busy={busy}
        result={linkResult}
        onLink={(sourceKey, productId) =>
          void guard(async () => {
            const result = await linkSourceProduct(sourceKey, productId);
            setLinkResult(
              result.alreadyLinked
                ? `Already linked to ${result.productId}.`
                : `Linked source to product ${result.productId}.`,
            );
            return null;
          })
        }
        onUnlink={(productId) =>
          void guard(async () => {
            const result = await unlinkSourceProduct(productId);
            setLinkResult(`Unlinked ${result.productId} (${result.clearedLinks} link(s) removed).`);
            return null;
          })
        }
      />
      <AlibabaSyncRunTable runs={runs} />
    </div>
  );
}
