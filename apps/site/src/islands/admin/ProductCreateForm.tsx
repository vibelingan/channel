import { useMutation } from '@tanstack/react-query';
import type { CollectionDef, CollectionDoc } from '@vibelingan-channel/shared';
import { useEffect, useRef, useState } from 'react';
import { RecordForm } from './RecordForm.tsx';
import { DraftSavedError } from './api.ts';
import {
  CreatedProductChangedError,
  type ProductCreationScope,
} from './catalog-product-create-api.ts';
import { createProductCreationController } from './catalog-product-creation.ts';

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
  const refresh = () => {
    try {
      setPending(control.controller?.pending().entries ?? []);
    } catch (error) {
      setError(error instanceof Error ? error : Error('Creation recovery is unavailable.'));
    }
  };
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
      if (error instanceof CreatedProductChangedError) setRecovered(error.product);
      refresh();
    },
  });
  async function check(selected: ProductCreationScope) {
    if (!control.controller || checking || save.isPending) return;
    setChecking(true);
    setError(null);
    try {
      const product = await control.controller.check(selected);
      if (mounted.current) {
        setRecovered(product);
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
      submitting={save.isPending || checking}
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
                    disabled={checking || save.isPending}
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
                <p>The original product is saved. Checking it did not publish or change it.</p>
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
                  className="mt-2 min-h-11 rounded-lg border border-amber-400 px-3 font-semibold"
                  onClick={() => props.onSaved(recovered, true)}
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
