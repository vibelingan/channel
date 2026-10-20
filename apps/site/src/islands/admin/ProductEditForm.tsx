import type { CollectionDoc } from '@vibelingan-channel/shared';
import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { onAuthChange } from '../../lib/session.ts';
import { ProductPublicationRecovery } from './ProductPublicationRecovery.tsx';
import { RecordForm } from './RecordForm.tsx';
import { useAdminSessionReconnector } from './admin-draft-recovery.ts';
import { AdminApiError, getRecord } from './api.ts';
import { type DraftSaveResult, createDraftSaveController } from './catalog-draft-save.ts';
import type { PublicationScope } from './catalog-product-operation-api.ts';
import {
  ProductPublicationError,
  pendingProductPublications,
  publishProductFromEditor,
} from './catalog-product-publication.ts';

type Props = ComponentProps<typeof RecordForm> & {
  initial: CollectionDoc;
  nativeSaveAvailable: boolean | undefined;
  onRetryAvailability: () => void;
  onSaved: (product: CollectionDoc, openEditor?: boolean) => void;
};
const stopBeforeClose =
  'Check or stop the original save before closing. Download your current edits if you need to keep them.';
const message = (error: unknown) =>
  error instanceof Error ? error : Error('The original save could not be checked.');

/** Keep private edits in the existing form while its original save is unresolved. */
export function ProductEditForm(props: Props) {
  const [control, setControl] = useState(() => {
    try {
      return { controller: createDraftSaveController(props.initial._id), error: null };
    } catch (error) {
      return { controller: null, error: message(error) };
    }
  });
  const originalOwner = useRef(control.controller?.owner);
  const [pending, setPending] = useState<PublicationScope[]>(() => {
    try {
      return control.controller?.pending().entries.map((entry) => entry.scope) ?? [];
    } catch {
      return [];
    }
  });
  const [publication, setPublication] = useState<{
    value: ReturnType<typeof pendingProductPublications> | null;
    error: Error | null;
  }>(() => {
    try {
      return { value: pendingProductPublications(props.initial._id), error: null };
    } catch (error) {
      return { value: null, error: message(error) };
    }
  });
  const [storageBlocked, setStorageBlocked] = useState(() => {
    try {
      return Boolean(control.controller?.pending().problems.length);
    } catch {
      return true;
    }
  });
  const [publicationResolved, setPublicationResolved] = useState(false);
  const [publicationNotice, setPublicationNotice] = useState('');
  const [sessionBlocked, setSessionBlocked] = useState(false);
  const [error, setError] = useState<Error | null>(control.error);
  const [result, setResult] = useState<DraftSaveResult>();
  const [busy, setBusy] = useState(false);
  const [downloaded, setDownloaded] = useState<string>();
  const running = useRef(false);
  // An inherited task opens read-only; closing it cannot lose a new submission.
  const publicationFromThisForm = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = onAuthChange(() => setSessionBlocked(true));
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, []);
  function refresh() {
    const snapshot = control.controller?.pending();
    setPending(snapshot?.entries.map((entry) => entry.scope) ?? []);
    setStorageBlocked(Boolean(snapshot?.problems.length));
  }
  const draft = props.initial.published !== true && props.initial.archived !== true;
  const publicationPending = Boolean(publication.value?.entries.length);
  const publicationOwner = publication.value?.owner;
  const blocked =
    props.readOnlyReason ??
    (sessionBlocked
      ? 'Your session changed. Sign in with the original account, then reconnect this form.'
      : control.error?.message ||
        publication.error?.message ||
        (publicationResolved
          ? 'The saved product may have changed. Download your edits, then close and reopen this product.'
          : publicationPending
            ? 'Check or stop the original publication before editing this product.'
            : pending.length
              ? 'Check or stop the original save before saving different edits.'
              : storageBlocked
                ? 'Browser recovery storage is unavailable. Keep this form open and retry the storage check.'
                : draft && props.nativeSaveAvailable === undefined
                  ? 'Save recovery availability could not be confirmed. Retry the availability check.'
                  : undefined));

  async function act(
    work: () => Promise<DraftSaveResult>,
    closeAfterSave = false,
    recordResult = true,
  ) {
    if (running.current || props.submitting) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const completed = await work();
      if (!mounted.current) return false;
      if (recordResult) setResult(completed);
      if (closeAfterSave && completed.state === 'saved' && completed.product) {
        const remaining = control.controller?.acknowledge(completed.scope);
        if (remaining?.entries.length || remaining?.problems.length)
          throw Error('The save is confirmed. Restore recovery storage before closing this form.');
        props.onSaved(completed.product);
      }
      return true;
    } catch (cause) {
      if (mounted.current) setError(message(cause));
      return false;
    } finally {
      running.current = false;
      if (mounted.current) {
        setBusy(false);
        try {
          refresh();
        } catch (cause) {
          setSessionBlocked(true);
          setError(message(cause));
        }
      }
    }
  }
  async function reconnect() {
    if (running.current || props.submitting || !originalOwner.current) return false;
    running.current = true;
    setBusy(true);
    try {
      const next = createDraftSaveController(props.initial._id);
      if (
        next.owner.actorId !== originalOwner.current.actorId ||
        next.owner.endpoint !== originalOwner.current.endpoint
      )
        throw Error('Return to the original account and API environment to reconnect this form.');
      await next.verifySession();
      const snapshot = next.pending();
      const originalPublication = pendingProductPublications(props.initial._id);
      if (!mounted.current) return false;
      setControl({ controller: next, error: null });
      setPending(snapshot.entries.map((entry) => entry.scope));
      setStorageBlocked(Boolean(snapshot.problems.length));
      setPublication({ value: originalPublication, error: null });
      setSessionBlocked(false);
      setResult(undefined);
      setError(null);
      return true;
    } catch (cause) {
      if (mounted.current) setError(message(cause));
      return false;
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  useAdminSessionReconnector(async () => {
    if (!(await reconnect()))
      throw Error(
        'This form could not reconnect. Keep it open and retry, or download your edits before leaving.',
      );
  });
  async function publish(values: Record<string, unknown>) {
    const controller = control.controller;
    if (!controller || running.current || props.submitting) return;
    running.current = true;
    publicationFromThisForm.current = true;
    setBusy(true);
    setError(null);
    setPublicationNotice('');
    let failedRecovery: ReturnType<typeof pendingProductPublications> | undefined;
    try {
      const product = await publishProductFromEditor(props.initial, values, () => {
        const snapshot = controller.pending();
        if (snapshot.entries.length || snapshot.problems.length)
          throw new AdminApiError(
            'SAVE_PENDING',
            'Resolve the original draft saves before publishing these edits.',
          );
      });
      if (mounted.current) props.onSaved(product);
    } catch (cause) {
      if (!mounted.current) return;
      setError(message(cause));
      if (cause instanceof ProductPublicationError && cause.owner && cause.checkpoint) {
        failedRecovery = { owner: cause.owner, entries: [cause.checkpoint] };
        setPublication({ value: failedRecovery, error: null });
      }
    } finally {
      running.current = false;
      if (mounted.current) {
        setBusy(false);
        try {
          controller.pending();
          const found = pendingProductPublications(props.initial._id);
          if (
            failedRecovery &&
            found.owner.actorId === failedRecovery.owner.actorId &&
            found.owner.endpoint === failedRecovery.owner.endpoint
          )
            for (const entry of failedRecovery.entries)
              if (
                !found.entries.some(
                  (current) => current.scope.operationId === entry.scope.operationId,
                )
              )
                found.entries.push(entry);
          setPublication({ value: found, error: null });
        } catch (cause) {
          setPublication((previous) => ({ ...previous, error: message(cause) }));
          setSessionBlocked(true);
        }
      }
    }
  }
  async function openPublishedProduct(
    readDraft: () => Readonly<Record<string, string | boolean>>,
    cleanupCandidates: () => Promise<void>,
  ) {
    const controller = control.controller;
    if (!controller || running.current || downloaded !== JSON.stringify(readDraft())) return;
    running.current = true;
    setBusy(true);
    try {
      await controller.verifySession();
      const drafts = controller.pending();
      if (
        drafts.entries.length ||
        drafts.problems.length ||
        pendingProductPublications(props.initial._id).entries.length
      )
        throw Error('Check or stop the remaining original tasks before reopening this product.');
      const product = await getRecord('products', props.initial._id, AbortSignal.timeout(8000));
      if (product._id !== props.initial._id)
        throw Error('The saved product could not be confirmed.');
      await cleanupCandidates();
      controller.pending();
      if (downloaded !== JSON.stringify(readDraft()))
        throw Error('Download your latest form edits before reopening this product.');
      if (mounted.current) props.onSaved(product, true);
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function finishRecovery(
    openEditor: boolean,
    readDraft: () => Readonly<Record<string, string | boolean>>,
    cleanupCandidates: () => Promise<void>,
  ) {
    if (
      !result ||
      !control.controller ||
      running.current ||
      (openEditor && downloaded !== JSON.stringify(readDraft()))
    )
      return;
    const controller = control.controller;
    const selected = result.scope;
    await act(
      async () => {
        const checked = await controller.check(selected);
        if (!['saved', 'historical', 'cancelled'].includes(checked.state))
          throw Error(
            'Finish checking or stopping the original save before reopening the product.',
          );
        const current =
          checked.product ??
          (await getRecord('products', props.initial._id, AbortSignal.timeout(8000)));
        controller.pending();
        if (current._id !== props.initial._id)
          throw Error('The current product could not be confirmed. Keep this form open.');
        if (
          !openEditor &&
          (checked.state !== 'cancelled' || current.updatedAt !== props.initial.updatedAt)
        )
          throw Error(
            'The saved product changed. Download your edits, then open the current product.',
          );
        if (openEditor && downloaded !== JSON.stringify(readDraft()))
          throw Error(
            'Your form edits changed. Download the current edits again before reopening.',
          );
        if (openEditor && controller.pending().entries.length === 1) {
          await cleanupCandidates();
          controller.pending();
          if (downloaded !== JSON.stringify(readDraft()))
            throw Error(
              'Your form edits changed. Download the current edits again before reopening.',
            );
        }
        const remaining = controller.acknowledge(checked.scope);
        if (remaining.problems.length)
          throw Error('Restore recovery storage before reopening this product.');
        setResult(undefined);
        if (remaining.entries.length)
          throw Error('Resolve the remaining original saves before reopening this product.');
        if (openEditor) props.onSaved(current, true);
        return checked;
      },
      false,
      false,
    );
  }
  function download(readDraft: () => Readonly<Record<string, string | boolean>>) {
    try {
      const current = readDraft();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      try {
        link.href = url;
        link.download = 'product-edits.json';
        document.body.appendChild(link);
        link.click();
        setDownloaded(JSON.stringify(current));
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (cause) {
      setError(message(cause));
    }
  }
  return (
    <RecordForm
      {...props}
      protectEdits={true}
      submitting={busy || props.submitting}
      error={error ?? props.error}
      readOnlyReason={blocked}
      closeBlockedReason={
        pending.length
          ? stopBeforeClose
          : publicationPending && publicationFromThisForm.current
            ? 'Check or stop the original publication before closing. Download your current edits if you need to keep them.'
            : undefined
      }
      onSubmit={(values) => {
        if (blocked || running.current) return;
        if (
          draft &&
          values.published === true &&
          values.archived !== true &&
          props.nativeSaveAvailable
        ) {
          void publish(values);
          return;
        }
        if (
          draft &&
          values.published !== true &&
          values.archived !== true &&
          props.nativeSaveAvailable
        ) {
          const controller = control.controller;
          if (!controller) return;
          void act(() => controller.save(props.initial, values), true);
        } else props.onSubmit(values);
      }}
      recovery={(readDraft, cleanupCandidates) =>
        pending.length || result || blocked || error || publicationNotice ? (
          <section
            aria-label="Original draft save recovery"
            className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
          >
            <output className="block">
              {result?.state === 'photos-pending'
                ? 'The product save is recorded. Continue or stop this original save to finish its photo cleanup.'
                : result?.state === 'saved'
                  ? 'The original draft save is confirmed. Your current form edits have been kept.'
                  : result?.state === 'historical'
                    ? 'The original save is historical. Download your edits before opening the current product.'
                    : result?.state === 'cancelled'
                      ? 'The original save is stopped. Saved product changes have been kept.'
                      : publicationPending || publicationResolved || publicationNotice
                        ? 'Your form edits have been kept while checking the original publication.'
                        : 'Keep this form open while checking the original save. Checking does not change the product.'}
            </output>
            {publicationNotice && <p className="mt-2">{publicationNotice}</p>}
            {pending.map((scope, index) => (
              <div key={scope.operationId} className="mt-2 flex flex-wrap gap-2">
                {(['check', 'resume', 'stop'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    disabled={busy || props.submitting || sessionBlocked}
                    className="min-h-11 rounded-lg border border-amber-400 px-3 font-semibold disabled:opacity-50"
                    onClick={() => {
                      const controller = control.controller;
                      if (controller) void act(() => controller[mode](scope));
                    }}
                  >
                    {mode === 'check'
                      ? 'Check original save'
                      : mode === 'resume'
                        ? 'Continue original save'
                        : 'Stop original save'}
                    {pending.length > 1 ? ` ${index + 1}` : ''}
                  </button>
                ))}
              </div>
            ))}
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className="min-h-11 rounded-lg border border-amber-400 px-3"
                onClick={() => download(readDraft)}
              >
                Download current edits
              </button>
              {result && ['saved', 'historical', 'cancelled'].includes(result.state) && (
                <>
                  <button
                    type="button"
                    disabled={busy || downloaded !== JSON.stringify(readDraft()) || sessionBlocked}
                    className="min-h-11 rounded-lg border border-amber-400 px-3 disabled:opacity-50"
                    onClick={() => {
                      void finishRecovery(true, readDraft, cleanupCandidates);
                    }}
                  >
                    Open saved product
                  </button>
                  {result.state === 'cancelled' && (
                    <button
                      type="button"
                      disabled={busy || sessionBlocked}
                      className="min-h-11 rounded-lg border border-amber-400 px-3 disabled:opacity-50"
                      onClick={() => {
                        void finishRecovery(false, readDraft, cleanupCandidates);
                      }}
                    >
                      Keep editing this draft
                    </button>
                  )}
                </>
              )}
              {publicationResolved && (
                <button
                  type="button"
                  disabled={busy || sessionBlocked || downloaded !== JSON.stringify(readDraft())}
                  className="min-h-11 rounded-lg border border-amber-400 px-3 disabled:opacity-50"
                  onClick={() => {
                    void openPublishedProduct(readDraft, cleanupCandidates);
                  }}
                >
                  Open current product
                </button>
              )}
              {sessionBlocked && originalOwner.current && (
                <button
                  type="button"
                  disabled={busy}
                  className="min-h-11 rounded-lg border border-amber-400 px-3"
                  onClick={() => {
                    void reconnect();
                  }}
                >
                  Reconnect original account
                </button>
              )}
              {!originalOwner.current && (
                <p className="mt-2">
                  Download your edits, then close and reopen this product after signing in. This
                  form could not confirm its original account.
                </p>
              )}
              {storageBlocked && (
                <button
                  type="button"
                  disabled={busy}
                  className="min-h-11 rounded-lg border border-amber-400 px-3"
                  onClick={() => {
                    try {
                      refresh();
                    } catch (cause) {
                      setError(message(cause));
                    }
                  }}
                >
                  Check recovery storage again
                </button>
              )}
              {draft && props.nativeSaveAvailable === undefined && (
                <button
                  type="button"
                  disabled={busy}
                  className="min-h-11 rounded-lg border border-amber-400 px-3"
                  onClick={props.onRetryAvailability}
                >
                  Check save availability again
                </button>
              )}
            </div>
            {publicationOwner &&
              publication.value?.entries.map((checkpoint) => (
                <ProductPublicationRecovery
                  key={checkpoint.scope.operationId}
                  product={props.initial}
                  owner={publicationOwner}
                  checkpoint={checkpoint}
                  disabled={busy || sessionBlocked}
                  onBusy={(value) => {
                    running.current = value;
                    setBusy(value);
                  }}
                  onResolved={(product, _notice, stoppedBeforeSave) => {
                    setPublication({
                      value: pendingProductPublications(props.initial._id),
                      error: null,
                    });
                    if (
                      stoppedBeforeSave &&
                      product._id === props.initial._id &&
                      product.updatedAt === props.initial.updatedAt &&
                      product.published !== true &&
                      product.archived !== true
                    ) {
                      setPublicationResolved(false);
                      setPublicationNotice(
                        'The original publication is stopped. Your form edits are still here.',
                      );
                      setError(null);
                      return;
                    }
                    setPublicationResolved(true);
                    setError(
                      Error(
                        'Publication checked. Download your current edits, then open the current product before editing.',
                      ),
                    );
                  }}
                />
              ))}
          </section>
        ) : null
      }
    />
  );
}
