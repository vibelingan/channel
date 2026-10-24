import { useCallback, useEffect, useRef, useState } from 'react';
import { onAuthChange } from '../../lib/session.ts';
import { AdminApiError, type BatchUpdateResult } from './api.ts';
import type { PublicationCheckpoint } from './catalog-product-operation-api.ts';
import { createPublicationBatch } from './catalog-publication-batch.ts';
import {
  type TablePublicationRecovery,
  recoverTablePublication,
} from './catalog-table-publication.ts';

/** Durable original tasks remain reachable when a page reload removes its mutation result. */
export function ProductPublicationInbox(props: {
  refreshKey: number;
  busy: boolean;
  names: Record<string, string>;
  onBusyChange?: (busy: boolean) => void;
  onRecovered: (result: BatchUpdateResult, selected: readonly PublicationCheckpoint[]) => void;
}) {
  const [recovery, setRecovery] = useState<TablePublicationRecovery>();
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState('');
  const [details, setDetails] = useState<readonly { id: string; message: string }[]>([]);
  const [page, setPage] = useState(0);
  const [running, setRunning] = useState(false);
  const mounted = useRef(false);
  const epoch = useRef(0);
  const active = useRef(false);
  const busyCallback = useRef(props.onBusyChange);
  busyCallback.current = props.onBusyChange;
  const [authRequired, setAuthRequired] = useState(false);
  const load = useCallback(() => {
    try {
      const batch = createPublicationBatch();
      const snapshot = batch.journal.read();
      setRecovery({ owner: batch.owner, checkpoints: snapshot.entries });
      setPage((current) =>
        Math.min(current, Math.max(0, Math.ceil(snapshot.entries.length / 20) - 1)),
      );
      setLoadError(
        snapshot.problems.length
          ? 'Browser recovery storage could not be read completely. Restore storage before continuing; original tasks are kept.'
          : '',
      );
    } catch (error) {
      setRecovery(undefined);
      setLoadError(
        error instanceof Error ? error.message : 'Original publication tasks could not be loaded.',
      );
      setAuthRequired(error instanceof AdminApiError && error.code === 'UNAUTHORIZED');
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    load();
    const auth = onAuthChange(() => {
      epoch.current++;
      setMessage('');
      setDetails([]);
      setAuthRequired(false);
      load();
    });
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key?.startsWith('channel:publication:v1:')) load();
    };
    window.addEventListener('storage', storage);
    return () => {
      mounted.current = false;
      epoch.current++;
      auth();
      window.removeEventListener('storage', storage);
      if (active.current) busyCallback.current?.(false);
    };
  }, [load]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: caller settlement refreshes local pointers without restarting auth listeners or invalidating an active action
  useEffect(() => {
    if (!active.current) load();
  }, [props.refreshKey, load]);
  async function act(
    mode: 'check' | 'continue' | 'cancel',
    selected: readonly PublicationCheckpoint[],
  ) {
    if (!recovery || active.current || props.busy || !selected.length) return;
    if (new Set(selected.map((entry) => entry.scope.productId)).size !== selected.length) {
      setMessage(
        'Some products have more than one original task. Use each task’s Check or Stop button before continuing one.',
      );
      return;
    }
    active.current = true;
    const current = epoch.current;
    setRunning(true);
    busyCallback.current?.(true);
    setMessage('');
    setAuthRequired(false);
    try {
      const result = await recoverTablePublication(
        {
          updated: 0,
          items: [],
          failures: [],
          publication: { owner: recovery.owner, checkpoints: [...selected] },
        },
        selected.map((entry) => entry.scope.productId),
        mode,
      );
      if (!mounted.current || epoch.current !== current) return;
      props.onRecovered(result, selected);
      setMessage(
        `${result.updated} original ${result.updated === 1 ? 'publication' : 'publications'} confirmed on the website. Stopping does not withdraw a publication that already completed.`,
      );
      setAuthRequired(result.failures.some((item) => item.code === 'UNAUTHORIZED'));
      setDetails(result.failures.map(({ id, message }) => ({ id, message })));
      load();
    } catch (error) {
      if (mounted.current && epoch.current === current)
        setMessage(
          error instanceof Error
            ? error.message
            : 'The original publications could not be checked.',
        );
    } finally {
      active.current = false;
      if (mounted.current) {
        setRunning(false);
        busyCallback.current?.(false);
      }
    }
  }
  const entries = recovery?.checkpoints ?? [];
  const visible = entries.slice(page * 20, page * 20 + 20);
  const disabled = props.busy || running;
  if (!entries.length && !message && !loadError) return null;
  const button =
    'min-h-11 rounded-lg border border-amber-400 px-3 font-semibold disabled:opacity-50';
  return (
    <section
      aria-label="Publication recovery"
      className="mt-4 space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
    >
      <p className="font-semibold">
        Original publication tasks{entries.length ? ` (${entries.length})` : ''}
      </p>
      {loadError && <output className="block break-words">{loadError}</output>}
      {message && <output className="block break-words">{message}</output>}
      {authRequired && (
        <a
          className="inline-block min-h-11 font-semibold underline"
          href="/login?returnTo=%2Fadmin"
        >
          Sign in to recover original tasks
        </a>
      )}
      {details.length > 0 && (
        <ul className="list-disc space-y-1 pl-5">
          {details.map((item) => (
            <li key={item.id}>
              {props.names[item.id] || item.id}: {item.message}
            </li>
          ))}
        </ul>
      )}
      {visible.length > 0 && (
        <>
          <p>
            Check, continue or stop these original tasks before publishing the products again.
            Checking only reads their results.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={button}
              disabled={disabled}
              onClick={() => {
                void act('check', visible);
              }}
            >
              Check original publications
            </button>
            <button
              type="button"
              className={button}
              disabled={disabled}
              onClick={() => {
                void act('continue', visible);
              }}
            >
              Continue original publications
            </button>
            <button
              type="button"
              className={button}
              disabled={disabled}
              onClick={() => {
                void act('cancel', visible);
              }}
            >
              Stop original publications
            </button>
          </div>
          <details className="rounded-lg border border-amber-200 px-3">
            <summary className="min-h-11 cursor-pointer content-center font-semibold">
              View individual tasks ({visible.length})
            </summary>
            <ul className="space-y-3">
              {visible.map((entry) => (
                <li key={entry.scope.operationId} className="border-t border-amber-200 pt-2">
                  <p className="break-words font-semibold">
                    {props.names[entry.scope.productId] || entry.scope.productId}
                  </p>
                  <p className="mt-1 break-all text-xs">Original task: {entry.scope.operationId}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(['check', 'continue', 'cancel'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={button}
                        disabled={disabled}
                        aria-label={`${mode === 'cancel' ? 'Stop' : mode === 'check' ? 'Check' : 'Continue'} original task ${entry.scope.operationId}`}
                        onClick={() => {
                          void act(mode, [entry]);
                        }}
                      >
                        {mode === 'cancel'
                          ? 'Stop task'
                          : mode === 'check'
                            ? 'Check task'
                            : 'Continue task'}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </details>
          {entries.length > 20 && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={button}
                disabled={disabled || page === 0}
                onClick={() => setPage((current) => current - 1)}
              >
                Previous tasks
              </button>
              <span>
                {page + 1} / {Math.ceil(entries.length / 20)}
              </span>
              <button
                type="button"
                className={button}
                disabled={disabled || (page + 1) * 20 >= entries.length}
                onClick={() => setPage((current) => current + 1)}
              >
                Next tasks
              </button>
            </div>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={disabled} onClick={load}>
          Reload recovery
        </button>
        {entries.length === 0 && (
          <button
            type="button"
            className={button}
            disabled={disabled}
            onClick={() => {
              setMessage('');
              setDetails([]);
            }}
          >
            Dismiss recovery result
          </button>
        )}
      </div>
    </section>
  );
}
