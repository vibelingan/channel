import { catalogIssueMessage } from '@vibelingan-channel/shared/catalog-issues';
import { useEffect, useRef, useState } from 'react';
import { getUser } from '../../lib/session.ts';
import { useSession } from '../auth/useSession.ts';
import { AdminApiError } from './api.ts';
import {
  type PreparationCommand,
  type PreparationResponse,
  type PreparationRunResult,
  type PreparationStatus,
  managePreparation,
  readPreparationResponse,
  runPreparation,
} from './catalog-preparation-api.ts';
import { readPreparationTask, savePreparationTask } from './catalog-preparation-task.ts';

type Props = { productId: string; onEdit: () => void; onReady: () => void };
type View = {
  jobId?: string;
  progress?: PreparationStatus['progress'];
  status?: PreparationStatus;
  reason?: PreparationRunResult['reason'];
  errorCode?: string;
};
function storage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
/** Preview stays read-only until an operator chooses a preparation action. */
export function CatalogPreparationControls(props: Props) {
  const session = useSession();
  const [sessionGeneration, setSessionGeneration] = useState(0);
  useEffect(() => {
    const changed = () => setSessionGeneration((value) => value + 1);
    // Unrelated preferences must not stop an active preparation wait.
    const stored = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) return;
      if (event.key !== null && event.key !== 'channel.token' && event.key !== 'channel.user')
        return;
      changed();
    };
    window.addEventListener('channel:auth', changed);
    window.addEventListener('storage', stored);
    return () => {
      window.removeEventListener('channel:auth', changed);
      window.removeEventListener('storage', stored);
    };
  }, []);
  if (!session.ready)
    return <output className="block p-4 text-sm text-slate-600">Checking session…</output>;
  if (session.user?.role !== 'admin') return null;
  return (
    <PreparationControls
      key={JSON.stringify([session.user.id, props.productId, sessionGeneration])}
      {...props}
      actorId={session.user.id}
    />
  );
}
function PreparationControls({ productId, actorId, onEdit, onReady }: Props & { actorId: string }) {
  const [view, setView] = useState<View>(() => {
    const saved = storage();
    const jobId = saved ? readPreparationTask(saved, actorId, productId) : null;
    return jobId ? { jobId } : {};
  });
  const [busy, setBusy] = useState(false);
  const [savedLocally, setSavedLocally] = useState(true);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const readyCallback = useRef(onReady);
  readyCallback.current = onReady;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);
  const currentActor = () => {
    const user = getUser();
    return user?.id === actorId && user.role === 'admin';
  };
  const accept = (controller: AbortController) =>
    mounted.current &&
    active.current === controller &&
    !controller.signal.aborted &&
    currentActor();
  const remember = (jobId: string) => {
    const saved = storage();
    setSavedLocally(saved !== null && savePreparationTask(saved, actorId, productId, jobId));
  };
  const request = async (command: PreparationCommand, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!currentActor()) throw new AdminApiError('FORBIDDEN', 'The signed-in operator changed.');
    return readPreparationResponse(await managePreparation(command, signal), {
      productId,
      action: command.action,
      ...(command.action === 'start' ? {} : { jobId: command.jobId }),
    });
  };
  const show = (
    response: PreparationResponse,
    controller: AbortController,
    requested?: 'cancel' | 'retry',
  ) => {
    if (!accept(controller)) return;
    const progress = 'status' in response ? response.status.progress : response.progress;
    remember(progress.jobId);
    setView({
      jobId: progress.jobId,
      progress,
      ...('status' in response ? { status: response.status } : {}),
      ...('recovery' in response &&
      requested &&
      (requested === 'retry' || progress.state !== 'cancelled')
        ? { reason: 'unknown' as const }
        : {}),
    });
    if ('status' in response && response.status.nextAction === 'ready') readyCallback.current();
  };
  async function act(action: 'prepare' | 'continue' | 'check' | 'cancel' | 'retry') {
    if (active.current || !currentActor()) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    try {
      if (action === 'prepare' || action === 'continue') {
        const result = await runPreparation(
          { productId, ...(action === 'continue' && view.jobId ? { jobId: view.jobId } : {}) },
          {
            signal: controller.signal,
            request,
            onProgress: (value) => {
              if (!accept(controller)) return;
              remember(value.progress.jobId);
              setView({
                jobId: value.progress.jobId,
                progress: value.progress,
                ...(value.status ? { status: value.status } : {}),
              });
            },
          },
        );
        if (!accept(controller)) return;
        if (result.jobId) remember(result.jobId);
        setView((previous) => ({
          ...previous,
          ...result,
          ...(result.status ? { progress: result.status.progress } : {}),
        }));
        if (result.reason === 'ready') readyCallback.current();
      } else if (view.jobId) {
        const observed = await request({ action: 'status', jobId: view.jobId }, controller.signal);
        show(observed, controller);
        if (action === 'check' || !('status' in observed) || !accept(controller)) return;
        const status = observed.status;
        if (action === 'cancel' && status.progress.state === 'completed') return;
        if (action === 'retry' && status.nextAction !== 'retry') return;
        const changed = await request(
          { action, jobId: view.jobId, expectedLeaseVersion: status.progress.leaseVersion },
          controller.signal,
        );
        show(changed, controller, action);
      }
    } catch (error) {
      if (!accept(controller)) return;
      if (error instanceof AdminApiError && ['UNAUTHORIZED', 'FORBIDDEN'].includes(error.code)) {
        setView((previous) => ({ ...previous, reason: 'needs-action', errorCode: error.code }));
      } else if (view.jobId) {
        try {
          show(
            await request({ action: 'status', jobId: view.jobId }, controller.signal),
            controller,
          );
        } catch (recoveryError) {
          if (accept(controller))
            setView((previous) => ({
              ...previous,
              reason: 'unknown',
              ...(recoveryError instanceof AdminApiError ? { errorCode: recoveryError.code } : {}),
            }));
        }
      } else setView((previous) => ({ ...previous, reason: 'unknown' }));
    } finally {
      if (mounted.current && active.current === controller) {
        active.current = null;
        setBusy(false);
      }
    }
  }
  const next = view.status?.nextAction;
  const state = view.progress?.state;
  const isReady = next === 'ready';
  const needsSignIn = view.errorCode === 'UNAUTHORIZED';
  const forbidden = view.errorCode === 'FORBIDDEN';
  const label = needsSignIn
    ? 'Sign in again to check this task.'
    : forbidden
      ? 'This preparation action is unavailable. You can still edit the saved product.'
      : busy
        ? 'Checking and preparing saved product…'
        : view.reason === 'unknown'
          ? view.jobId
            ? 'The result is not confirmed. Check this task before continuing.'
            : 'Preparation was not confirmed. Use Prepare saved product to recover, or edit the saved product.'
          : view.reason === 'paused'
            ? 'Waiting stopped. The server task can still be checked or continued.'
            : isReady
              ? 'Saved product content is ready. Publishing still checks category and permissions.'
              : state === 'cancelled'
                ? 'Preparation was cancelled. Saved product content has been kept.'
                : next === 'edit'
                  ? 'Saved product data needs a correction.'
                  : next === 'restart'
                    ? 'Saved product data changed. Check the current product.'
                    : next === 'retry'
                      ? 'This task needs an explicit retry.'
                      : next === 'wait'
                        ? 'Preparation is running. Check its result.'
                        : view.jobId
                          ? 'A saved preparation task is available.'
                          : 'Prepare saved product content when its images or data need checking.';
  const disabled = busy || needsSignIn || forbidden;
  const button = 'min-h-11 rounded-lg border border-slate-300 px-3 text-sm disabled:opacity-50';
  return (
    <section
      aria-label="Saved product preparation"
      className="mx-6 mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900"
    >
      <output className="block" aria-live="polite">
        {label}
      </output>
      {view.progress?.media && (
        <p className="mt-1 text-slate-600">
          Photos checked: {view.progress.media.checked} of {view.progress.media.total}.
        </p>
      )}
      {view.status?.report?.issues.length ? (
        <ul aria-label="Preparation issues" className="mt-2 list-disc space-y-1 pl-5">
          {view.status.report.issues.map((issue, index) => (
            <li key={`${index}:${issue.path}`}>{catalogIssueMessage(issue)}</li>
          ))}
        </ul>
      ) : null}
      {!savedLocally && (
        <p className="mt-2 text-amber-800">
          Browser recovery storage is unavailable. Keep this view open or check the saved product
          again.
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-3">
        {!view.jobId && (
          <button
            type="button"
            className={button}
            disabled={disabled}
            onClick={() => void act('prepare')}
          >
            Prepare saved product
          </button>
        )}
        {view.jobId && (
          <button
            type="button"
            className={button}
            disabled={disabled}
            onClick={() => void act('check')}
          >
            Check result
          </button>
        )}
        {view.jobId &&
          !isReady &&
          next !== 'edit' &&
          next !== 'retry' &&
          next !== 'restart' &&
          state !== 'cancelled' && (
            <button
              type="button"
              className={button}
              disabled={disabled}
              onClick={() => void act('continue')}
            >
              Continue preparation
            </button>
          )}
        {(next === 'restart' ||
          view.errorCode === 'INVALID_RESPONSE' ||
          view.errorCode === 'NOT_FOUND') && (
          <button
            type="button"
            className={button}
            disabled={disabled}
            onClick={() => void act('prepare')}
          >
            Check current product
          </button>
        )}
        {next === 'retry' && (
          <button
            type="button"
            className={button}
            disabled={disabled}
            onClick={() => void act('retry')}
          >
            Retry preparation
          </button>
        )}
        {view.jobId &&
          view.progress &&
          !isReady &&
          state !== 'completed' &&
          state !== 'cancelled' && (
            <button
              type="button"
              className={button}
              disabled={disabled}
              onClick={() => void act('cancel')}
            >
              Cancel preparation
            </button>
          )}
        {busy && (
          <button
            type="button"
            className={button}
            onClick={() => {
              active.current?.abort();
              setView((previous) => ({ ...previous, reason: 'paused' }));
            }}
          >
            Stop waiting
          </button>
        )}
        <button type="button" className={button} onClick={onEdit}>
          Edit saved product
        </button>
        {needsSignIn && (
          <a
            className="inline-flex min-h-11 items-center underline"
            href="/login?returnTo=%2Fadmin"
          >
            Sign in again
          </a>
        )}
      </div>
      {isReady && (
        <p className="mt-2 text-slate-600">
          To delete a prepared photo, first remove or replace it in this product's photo selection
          and save.
        </p>
      )}
    </section>
  );
}
