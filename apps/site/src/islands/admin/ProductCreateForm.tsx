import { useMutation } from '@tanstack/react-query';
import type { CollectionDef, CollectionDoc } from '@vibelingan-channel/shared';
import { useEffect, useRef, useState } from 'react';
import { ProductPublicationRecovery } from './ProductPublicationRecovery.tsx';
import { RecordForm } from './RecordForm.tsx';
import { useAdminSessionReconnector } from './admin-draft-recovery.ts';
import { DraftSavedError, getRecord } from './api.ts';
import {
  CreatedProductChangedError,
  type ProductCreationScope,
} from './catalog-product-create-api.ts';
import { createProductCreationController } from './catalog-product-creation.ts';
import type { PublicationCheckpoint } from './catalog-product-operation-api.ts';
import {
  ProductPublicationError,
  pendingProductPublications,
} from './catalog-product-publication.ts';
import type { PublicationOwner } from './catalog-product-publication.ts';

export function ProductCreateForm(props: {
  collection: CollectionDef;
  title: string;
  defaults?: Record<string, unknown>;
  onSaved: (product: CollectionDoc, openEditor?: boolean) => void;
  onCancel: () => void;
}) {
  const [control] = useState(() => {
    try {
      return { controller: createProductCreationController(), error: null };
    } catch (error) {
      return {
        controller: null,
        error: error instanceof Error ? error : Error('Sign in again before creating a product.'),
      };
    }
  });
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [pending, setPending] = useState<readonly ProductCreationScope[]>(() => {
    try {
      return control.controller?.pending().entries ?? [];
    } catch {
      return [];
    }
  });
  const [error, setError] = useState<Error | null>(control.error);
  const [checking, setChecking] = useState(false);
  const [recovered, setRecovered] = useState<CollectionDoc | null>(null);
  const [recoveredScope, setRecoveredScope] = useState<ProductCreationScope>();
  const [publication, setPublication] = useState<{
    owner: PublicationOwner;
    entries: PublicationCheckpoint[];
  }>();
  const [publicationBusy, setPublicationBusy] = useState(false);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [publicationMessage, setPublicationMessage] = useState('');
  const refresh = () => {
    try {
      setPending(control.controller?.pending().entries ?? []);
    } catch (error) {
      setError(error instanceof Error ? error : Error('Creation recovery is unavailable.'));
    }
  };
  useAdminSessionReconnector(async () => {
    if (!control.controller) throw control.error;
    await control.controller.reconnect();
    refresh();
  });
  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) => {
      if (!control.controller) throw control.error;
      return control.controller.save(values);
    },
    onSuccess: (product) => {
      if (mounted.current) props.onSaved(product);
    },
    onError: (error) => {
      if (!mounted.current) return;
      setError(error);
      if (error instanceof DraftSavedError) setRecovered(error.draft);
      if (error instanceof CreatedProductChangedError) {
        setRecovered(error.product);
        setPublicationMessage(error.message);
        try {
          const pointers = control.controller?.pending().entries ?? [];
          setRecoveredScope(pointers.length === 1 ? pointers[0] : undefined);
          setPublication(pendingProductPublications(error.product._id));
        } catch (recoveryError) {
          setRecoveryBlocked(true);
          setError(
            recoveryError instanceof Error
              ? recoveryError
              : Error('Publication recovery is unavailable.'),
          );
        }
      }
      if (error instanceof ProductPublicationError) {
        setRecovered(error.product);
        setPublicationMessage(error.message);
        try {
          const pointers = control.controller?.pending().entries ?? [];
          setRecoveredScope(pointers.length === 1 ? pointers[0] : undefined);
        } catch {
          setRecoveryBlocked(true);
        }
        if (error.owner && error.checkpoint)
          setPublication({ owner: error.owner, entries: [error.checkpoint] });
      }
      refresh();
    },
  });
  async function check(selected: ProductCreationScope) {
    if (!control.controller || checking || save.isPending) return;
    setChecking(true);
    setError(null);
    try {
      const product = await control.controller.check(selected, { retain: true });
      if (mounted.current) {
        setRecovered(product);
        setRecoveredScope(selected);
        setPublicationMessage('');
        setRecoveryBlocked(true);
        const found = pendingProductPublications(product._id);
        setPublication(found);
        setRecoveryBlocked(false);
        refresh();
      }
    } catch (error) {
      if (mounted.current)
        setError(
          error instanceof Error ? error : Error('The original creation could not be checked.'),
        );
    } finally {
      if (mounted.current) setChecking(false);
    }
  }
  async function openSaved() {
    if (
      !recovered ||
      checking ||
      publicationBusy ||
      recoveryBlocked ||
      publication?.entries.length ||
      !control.controller
    )
      return;
    setChecking(true);
    try {
      control.controller.pending();
      const product = recoveredScope
        ? await control.controller.check(recoveredScope, { retain: true })
        : await getRecord('products', recovered._id, AbortSignal.timeout(8000));
      control.controller.pending();
      if (!mounted.current) return;
      setRecovered(product);
      const original = pendingProductPublications(product._id);
      setPublication(original);
      if (original.entries.length) return;
      if (recoveredScope) control.controller.acknowledge(recoveredScope);
      props.onSaved(product, true);
    } catch (error) {
      if (mounted.current)
        setError(
          error instanceof Error
            ? error
            : Error('Return to the original account before opening this product.'),
        );
    } finally {
      if (mounted.current) setChecking(false);
    }
  }
  function saveCurrentEdits(readDraft: () => Readonly<Record<string, string | boolean>>) {
    try {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(readDraft(), null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      try {
        link.href = url;
        link.download = 'product-draft.json';
        document.body.appendChild(link);
        link.click();
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      setError(
        error instanceof Error
          ? error
          : Error('Current edits could not be saved. Keep this form open.'),
      );
    }
  }
  return (
    <RecordForm
      collection={props.collection}
      title={props.title}
      defaults={props.defaults}
      submitting={save.isPending || checking || publicationBusy}
      error={error}
      readOnlyReason={
        recovered
          ? 'This product already exists. Open the saved product to continue editing.'
          : control.error?.message
      }
      onCancel={props.onCancel}
      onSubmit={(values) => {
        setError(null);
        save.mutate(values);
      }}
      recovery={(readDraft) =>
        pending.length > 0 || recovered ? (
          <section
            aria-label="Product creation recovery"
            className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
          >
            {pending.length > 0 && (
              <>
                <p>
                  An earlier creation needs checking. Check the saved product, or submit the
                  original details to retry the same creation.
                </p>
                {pending.map((entry, index) => (
                  <button
                    key={entry.attemptId}
                    type="button"
                    disabled={checking || save.isPending || publicationBusy}
                    className="mt-2 mr-2 min-h-11 rounded-lg border border-amber-400 px-3 font-semibold disabled:opacity-50"
                    onClick={() => {
                      void check(entry);
                    }}
                  >
                    Check saved product{pending.length > 1 ? ` ${index + 1}` : ''}
                  </button>
                ))}
              </>
            )}
            {recovered && (
              <>
                <p>The original product is saved. Checking creation only reads its saved state.</p>
                {publicationMessage && <output className="mt-2 block">{publicationMessage}</output>}
                {publication?.entries.map((entry) => (
                  <ProductPublicationRecovery
                    key={entry.scope.operationId}
                    product={recovered}
                    owner={publication.owner}
                    checkpoint={entry}
                    disabled={publicationBusy}
                    onBusy={setPublicationBusy}
                    onResolved={(product, message) => {
                      setRecovered(product);
                      setPublicationMessage(message);
                      setPublication(
                        (current) =>
                          current && {
                            ...current,
                            entries: current.entries.filter(
                              (item) => item.scope.operationId !== entry.scope.operationId,
                            ),
                          },
                      );
                    }}
                  />
                ))}
                <p className="mt-2">
                  Opening it replaces the fields in this form. Save any current edits you still need
                  first.
                </p>
                <button
                  type="button"
                  className="mt-2 mr-2 min-h-11 rounded-lg border border-amber-400 px-3 font-semibold"
                  onClick={() => saveCurrentEdits(readDraft)}
                >
                  Save current edits
                </button>
                <button
                  type="button"
                  className="mt-2 min-h-11 rounded-lg border border-amber-400 px-3 font-semibold disabled:opacity-50"
                  disabled={
                    publicationBusy || recoveryBlocked || Boolean(publication?.entries.length)
                  }
                  onClick={() => {
                    void openSaved();
                  }}
                >
                  Open saved product
                </button>
              </>
            )}
          </section>
        ) : undefined
      }
    />
  );
}
