import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import {
  type CatalogTaxonomy,
  type CatalogTaxonomyCommand,
  CatalogTaxonomyCommandSchema,
  MAX_TAXONOMY_CHILDREN,
  PRODUCT_FAMILY_OPTIONS,
  type ProductFamily,
  isProductFamily,
} from '@vibelingan-channel/shared';
import { useEffect, useRef, useState } from 'react';
import { Select } from '../../components/form/Select.tsx';
import { taxonomyCall } from './api.ts';
import { taxonomyQuery } from './taxonomy-ui-state.ts';

const inputClass =
  'mt-1 min-h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-100';
const buttonClass =
  'min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold disabled:opacity-50';

export function CatalogTaxonomyManager() {
  const client = useQueryClient();
  const queries = useQueries({ queries: PRODUCT_FAMILY_OPTIONS.map(taxonomyQuery) });
  const [family, setFamily] = useState<ProductFamily>('headphones');
  const [draft, setDraft] = useState<CatalogTaxonomy | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<ProductFamily | 'cancel' | null>(null);
  const [message, setMessage] = useState('');
  const [needsReload, setNeedsReload] = useState(false);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const editGenerationRef = useRef(0);
  const mutation = useMutation({
    mutationFn: (command: CatalogTaxonomyCommand) => taxonomyCall(command),
    retry: false,
    networkMode: 'always',
  });
  const query = queries[PRODUCT_FAMILY_OPTIONS.indexOf(family)];
  const registry = query.data;
  const value = draft ?? registry;
  const busy = pending || query.isFetching;
  const parsed = value
    ? CatalogTaxonomyCommandSchema.safeParse({
        kind: 'taxonomy',
        operation: 'save',
        family,
        expectedRevision: value.revision,
        name: value.name,
        children: value.children,
      })
    : null;
  const stale = Boolean(draft && registry && draft.revision !== registry.revision);
  const blocked = busy || needsReload || stale || Boolean(query.error);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      editGenerationRef.current += 1;
    };
  }, []);

  function edit(next: CatalogTaxonomy) {
    editGenerationRef.current += 1;
    setDraft(next);
    setConfirming(false);
    setMessage('');
  }

  function reset(nextFamily = family) {
    editGenerationRef.current += 1;
    setDraft(null);
    setFamily(nextFamily);
    setConfirming(false);
    setDiscardTarget(null);
    setNeedsReload(false);
    setMessage('');
  }

  async function reload() {
    if (inFlight.current) return;
    const generation = ++editGenerationRef.current;
    setConfirming(false);
    const result = await query.refetch();
    if (mounted.current && generation === editGenerationRef.current && result.isSuccess) reset();
  }

  async function save() {
    if (!confirming || !parsed?.success || blocked || !draft || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setConfirming(false);
    try {
      const result = await mutation.mutateAsync(parsed.data);
      if (!mounted.current) return;
      if ('registry' in result) {
        client.setQueryData(['catalog-taxonomy', family], result.registry);
        setDraft(null);
        setMessage('Categories saved.');
        await client.invalidateQueries({ queryKey: ['catalog-taxonomy', family] });
      } else {
        setNeedsReload(result.status !== 'invalid');
        setMessage(
          result.status === 'conflict'
            ? 'Categories changed since this draft was opened. Reload before saving.'
            : `Categories were not saved (${result.status}).`,
        );
      }
    } catch {
      if (mounted.current) {
        setNeedsReload(true);
        setMessage('Save was not confirmed. Reload categories before trying again.');
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return (
    <section
      aria-label="Catalog categories"
      className="min-w-0 space-y-4 border-t border-brand-200 py-4"
    >
      <h2 className="text-lg font-semibold text-ink">Website categories</h2>
      <Select
        label="Website main category"
        required
        placeholder=""
        value={family}
        disabled={pending || discardTarget !== null}
        options={PRODUCT_FAMILY_OPTIONS.map((item, index) => ({
          value: item,
          label: queries[index].data?.name ?? item,
        }))}
        onChange={(next) => {
          if (!isProductFamily(next) || next === family) return;
          if (draft) setDiscardTarget(next);
          else reset(next);
        }}
      />
      {discardTarget && (
        <div className="space-y-2 border-y border-amber-200 py-3" role="alert">
          <p className="text-sm">Discard unsaved category changes?</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              onClick={() => reset(discardTarget === 'cancel' ? family : discardTarget)}
            >
              Discard changes
            </button>
            <button type="button" className={buttonClass} onClick={() => setDiscardTarget(null)}>
              Keep editing
            </button>
          </div>
        </div>
      )}
      {query.isPending && <output className="block">Loading categories...</output>}
      {query.error && (
        <div role="alert" className="space-y-2 text-sm text-red-700">
          <p>{query.error.message}</p>
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => void reload()}
          >
            Retry loading categories
          </button>
        </div>
      )}
      {value && (
        <>
          <fieldset disabled={blocked || discardTarget !== null} className="min-w-0 space-y-4">
            <label className="block text-sm font-medium text-ink">
              Public main category name
              <input
                className={inputClass}
                maxLength={80}
                required
                value={value.name}
                onChange={(event) => edit({ ...value, name: event.currentTarget.value })}
              />
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">
                Subcategories ({value.children.length}/{MAX_TAXONOMY_CHILDREN})
              </h3>
              <button
                type="button"
                className={buttonClass}
                disabled={value.children.length >= MAX_TAXONOMY_CHILDREN}
                onClick={() =>
                  edit({
                    ...value,
                    children: [
                      ...value.children,
                      {
                        id: crypto.randomUUID().toLowerCase(),
                        name: '',
                        slug: '',
                        order: Math.min(
                          Number.MAX_SAFE_INTEGER,
                          Math.max(
                            -1,
                            ...value.children.map((child) =>
                              Number.isFinite(child.order) ? child.order : -1,
                            ),
                          ) + 1,
                        ),
                        status: 'active',
                      },
                    ],
                  })
                }
              >
                Add subcategory
              </button>
            </div>
            <ul className="divide-y divide-slate-200">
              {value.children.map((child, index) => {
                const existing = registry?.children.some((item) => item.id === child.id);
                const update = (patch: Partial<CatalogTaxonomy['children'][number]>) =>
                  edit({
                    ...value,
                    children: value.children.map((item) =>
                      item.id === child.id ? { ...item, ...patch } : item,
                    ),
                  });
                return (
                  <li
                    key={child.id}
                    className="grid min-w-0 grid-cols-1 gap-3 py-4 sm:grid-cols-2 lg:grid-cols-[2fr_2fr_1fr_auto]"
                  >
                    <label className="min-w-0 text-sm font-medium">
                      Subcategory name
                      <input
                        aria-label={`Subcategory ${index + 1} name`}
                        className={inputClass}
                        required
                        maxLength={80}
                        value={child.name}
                        onChange={(event) => update({ name: event.currentTarget.value })}
                      />
                    </label>
                    <label className="min-w-0 text-sm font-medium">
                      URL slug
                      <input
                        aria-label={`Subcategory ${index + 1} slug`}
                        className={inputClass}
                        required
                        maxLength={80}
                        readOnly={existing}
                        value={child.slug}
                        onChange={(event) => update({ slug: event.currentTarget.value })}
                      />
                    </label>
                    <label className="min-w-0 text-sm font-medium">
                      Order
                      <input
                        aria-label={`Subcategory ${index + 1} order`}
                        className={inputClass}
                        type="number"
                        min={0}
                        step={1}
                        max={Number.MAX_SAFE_INTEGER}
                        required
                        value={Number.isFinite(child.order) ? child.order : ''}
                        onChange={(event) =>
                          update({
                            order:
                              event.currentTarget.value === ''
                                ? Number.NaN
                                : Number(event.currentTarget.value),
                          })
                        }
                      />
                    </label>
                    <label className="flex min-h-11 items-center gap-2 self-end text-sm">
                      <input
                        type="checkbox"
                        checked={child.status === 'active'}
                        onChange={(event) =>
                          update({ status: event.currentTarget.checked ? 'active' : 'archived' })
                        }
                      />
                      Active
                    </label>
                    <label className="min-w-0 text-xs text-slate-600 sm:col-span-2 lg:col-span-4">
                      Subcategory ID
                      <input className={inputClass} readOnly value={child.id} />
                    </label>
                    {!existing && (
                      <button
                        type="button"
                        className={`${buttonClass} justify-self-start`}
                        onClick={() =>
                          edit({
                            ...value,
                            children: value.children.filter((item) => item.id !== child.id),
                          })
                        }
                      >
                        Remove new subcategory
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </fieldset>
          {draft && parsed && !parsed.success && (
            <p role="alert" className="text-sm text-red-700">
              {parsed.error.issues[0]?.message}
            </p>
          )}
          {stale && (
            <p role="alert" className="text-sm text-amber-800">
              A newer category revision is available. Reload to discard this stale draft.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={`${buttonClass} bg-brand-700 text-white`}
              disabled={blocked || !draft || !parsed?.success || discardTarget !== null}
              onClick={() => setConfirming(true)}
            >
              Save categories
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={pending || !draft}
              onClick={() => setDiscardTarget('cancel')}
            >
              Cancel changes
            </button>
            {(needsReload || stale) && (
              <button
                type="button"
                className={buttonClass}
                disabled={busy}
                onClick={() => void reload()}
              >
                Reload and discard changes
              </button>
            )}
          </div>
          {confirming && (
            <div
              className="space-y-3 border-y border-brand-200 py-3"
              aria-label="Confirm category changes"
            >
              <p className="break-words text-sm">
                Save {value.name} and {value.children.length} subcategories at revision{' '}
                {value.revision}? Public category names will change. Archived subcategories remain
                on existing products.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={buttonClass}
                  disabled={blocked}
                  onClick={() => void save()}
                >
                  Confirm category save
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={pending}
                  onClick={() => setConfirming(false)}
                >
                  Cancel confirmation
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {pending && <output className="block text-sm">Saving categories...</output>}
      {!pending && message && <output className="block break-words text-sm">{message}</output>}
    </section>
  );
}
