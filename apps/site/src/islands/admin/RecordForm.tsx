import {
  type CollectionDef,
  type CollectionDoc,
  type FieldDef,
  LEGACY_HEADPHONES_CATEGORY_OPTIONS,
  type ProductFamily,
  needsCategoryReview,
} from '@vibelingan-channel/shared';
import { useState } from 'react';
import { Select } from '../../components/form/Select.tsx';
import { FileDownloadLink } from './FileDownloadLink.tsx';
import { ImageManager } from './ImageManager.tsx';
import { ProductPricingEditor } from './ProductPricingEditor.tsx';
import { QuantityTierPricingEditor } from './QuantityTierPricingEditor.tsx';
import {
  importAlibabaSourceImage,
  removeAlibabaImportedImage,
} from './alibaba-catalog-sync/alibaba-api.ts';
import { importAlibabaGallery } from './alibaba-gallery-import.ts';
import { alibabaSourcePreviewUrls } from './alibaba-source-preview.ts';
import { AdminApiError } from './api.ts';
import { ADMIN_PRODUCT_FAMILY_LABELS } from './product-family-tabs.ts';

interface RecordFormProps {
  collection: CollectionDef;
  title: string;
  initial?: CollectionDoc;
  defaults?: Record<string, unknown>;
  submitting: boolean;
  error: Error | null;
  onSubmit: (values: Record<string, unknown>) => void;
  onCancel: () => void;
}

type FormState = Record<string, string | boolean>;

interface ProductFormSection {
  heading: string;
  fields: FieldDef[];
}

const PRODUCT_SECTION_FIELDS = [
  { heading: 'Identity', fields: ['productFamily', 'category', 'skuCode', 'slug'] },
  { heading: 'Content', fields: ['name', 'series', 'modName', 'modType', 'description'] },
  { heading: 'Media', fields: ['imageIds'] },
  {
    heading: 'Pricing & Order',
    fields: ['catalogPricingMode', 'moq', 'unitPrice', 'wholesalePrice', 'manualCatalogPricing'],
  },
  { heading: 'Lifecycle', fields: ['published', 'archived'] },
] as const;

export function productEditableFields(collection: CollectionDef): FieldDef[] {
  return collection.fields.filter((field) => !field.readOnly && !field.hideInForm);
}

export function productFormSections(collection: CollectionDef): ProductFormSection[] {
  if (collection.name !== 'products') return [];
  const editable = new Map(productEditableFields(collection).map((field) => [field.name, field]));
  return PRODUCT_SECTION_FIELDS.map((section) => ({
    heading: section.heading,
    fields: section.fields.flatMap((name) => editable.get(name) ?? []),
  })).filter((section) => section.fields.length > 0);
}

export function productReadOnlyFields(
  collection: CollectionDef,
  initial: CollectionDoc | undefined,
): Array<{ label: string; value: string }> {
  if (collection.name !== 'products' || !initial) return [];
  return collection.fields
    .filter(
      (field) =>
        field.readOnly && field.name.startsWith('alibaba') && field.name !== 'alibabaSourceReview',
    )
    .flatMap((field) => {
      const value = initial[field.name];
      return value === undefined || value === null || value === ''
        ? []
        : [
            {
              label: field.label,
              value: typeof value === 'object' ? JSON.stringify(value) : String(value),
            },
          ];
    });
}

export function productFamilyTransition(
  state: FormState,
  nextFamily: ProductFamily,
): { patch: FormState; announcement: string } {
  const category = String(state.category ?? '');
  const clearCategory =
    nextFamily !== 'headphones' &&
    (LEGACY_HEADPHONES_CATEGORY_OPTIONS as readonly string[]).includes(category);
  return {
    patch: { productFamily: nextFamily, ...(clearCategory ? { category: '' } : {}) },
    announcement: clearCategory ? 'Subcategory cleared because it applies only to Headphones.' : '',
  };
}

export function productFormErrorTargets(error: Error | null): Record<string, string> {
  if (!(error instanceof AdminApiError)) return {};
  const targets: Record<string, string> = {};
  for (const message of error.message
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const lower = message.toLowerCase();
    const field = lower.includes('slug')
      ? 'slug'
      : lower.includes('sku')
        ? 'skuCode'
        : lower.includes('image')
          ? 'imageIds'
          : lower.includes('family')
            ? 'productFamily'
            : lower.includes('description')
              ? 'description'
              : lower.includes('pricing') || lower.includes('tier')
                ? 'manualCatalogPricing'
                : lower.includes('archiv')
                  ? 'archived'
                  : lower.includes('name')
                    ? 'name'
                    : null;
    if (field) targets[field] = message;
  }
  return targets;
}

function initialState(
  collection: CollectionDef,
  initial?: CollectionDoc,
  defaults: Record<string, unknown> = {},
): FormState {
  const state: FormState = {};
  for (const field of collection.fields) {
    if (field.readOnly) continue;
    const raw = initial?.[field.name] ?? defaults[field.name];
    if (field.type === 'boolean') {
      state[field.name] = Boolean(raw);
    } else if (field.type === 'json') {
      state[field.name] =
        raw === undefined || (field.name === 'manualCatalogPricing' && raw === '')
          ? ''
          : JSON.stringify(raw, null, 2);
    } else {
      state[field.name] = raw === undefined || raw === null ? '' : String(raw);
    }
  }
  return state;
}

export function RecordForm({
  collection,
  title,
  initial,
  defaults,
  submitting,
  error,
  onSubmit,
  onCancel,
}: RecordFormProps) {
  const [state, setState] = useState<FormState>(() => initialState(collection, initial, defaults));
  const [localError, setLocalError] = useState('');
  const [fieldAnnouncement, setFieldAnnouncement] = useState('');
  const [imageBusy, setImageBusy] = useState(false);
  const [sourceImageBusy, setSourceImageBusy] = useState(false);
  const [sourceImageNotice, setSourceImageNotice] = useState('');
  const [newSourceImageIds, setNewSourceImageIds] = useState<string[]>([]);
  const [pricingInvalid, setPricingInvalid] = useState(false);

  function setField(name: string, value: string | boolean) {
    if (collection.name === 'products' && name === 'productFamily') {
      const transition = productFamilyTransition(state, value as ProductFamily);
      setFieldAnnouncement(transition.announcement);
      setState((prev) => ({ ...prev, ...transition.patch }));
      return;
    }
    setState((prev) => ({ ...prev, [name]: value }));
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLocalError('');
    try {
      const values = coerceValues(collection, state, initial);
      onSubmit(values);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'Invalid input');
    }
  }

  const sourcePreviewUrls = alibabaSourcePreviewUrls(initial?.alibabaSourceImageUrls, 9);
  const sourcePreviewUrl = sourcePreviewUrls[0];

  async function importSourceGallery() {
    if (!sourcePreviewUrl || sourceImageBusy) return;
    setSourceImageBusy(true);
    setSourceImageNotice('');
    try {
      let currentIds: string[] = [];
      try {
        const parsed: unknown = JSON.parse(String(state.imageIds || '[]'));
        if (Array.isArray(parsed)) {
          currentIds = parsed.filter((value): value is string => typeof value === 'string');
        }
      } catch {
        currentIds = [];
      }
      const result = await importAlibabaGallery({
        sourceUrls: sourcePreviewUrls,
        imageIds: currentIds,
        importImage: importAlibabaSourceImage,
        onProgress: (ids) => setField('imageIds', JSON.stringify(ids)),
      });
      setNewSourceImageIds((ids) => [...new Set([...ids, ...result.createdIds])]);
      setSourceImageNotice(
        [
          `${result.imageIds.length - currentIds.length} images added. Save to attach them to this product.`,
          ...result.failures.map(
            (failure) => `Source image ${failure.position}: ${failure.message}`,
          ),
          ...(result.remaining
            ? [
                `${result.remaining} source images not imported${result.imageIds.length >= 9 ? ': the 9-image limit is reached' : ': the import stopped; check the error before retrying'}.`,
              ]
            : []),
        ].join(' '),
      );
    } catch (importError) {
      setSourceImageNotice(
        importError instanceof Error ? importError.message : 'Alibaba image import failed.',
      );
    } finally {
      setSourceImageBusy(false);
    }
  }

  async function cancelWithCandidateCleanup() {
    setSourceImageBusy(true);
    await Promise.allSettled(newSourceImageIds.map(removeAlibabaImportedImage));
    onCancel();
  }

  const editableFields = productEditableFields(collection);
  const sections = productFormSections(collection);
  const fieldErrors = collection.name === 'products' ? productFormErrorTargets(error) : {};
  const readOnlyFields = productReadOnlyFields(collection, initial);
  const aggregateError =
    localError || (Object.keys(fieldErrors).length === 0 ? error?.message : '');

  return (
    <dialog
      open
      aria-labelledby="record-form-title"
      className="fixed inset-0 z-50 m-0 flex h-dvh w-screen max-w-none items-center justify-center bg-slate-900/40 p-4"
    >
      <form
        method="post"
        onSubmit={handleSubmit}
        className="max-h-[90dvh] min-w-0 w-full max-w-lg overflow-auto rounded-2xl bg-white p-6 shadow-xl"
      >
        <h2 id="record-form-title" className="text-lg font-semibold text-slate-900">
          {title}
        </h2>

        {sections.length > 0 ? (
          <div className="mt-4 space-y-6">
            {sections.map((section) => (
              <fieldset
                key={section.heading}
                disabled={sourceImageBusy}
                className="min-w-0 space-y-4 border-t border-slate-200 pt-4 first:border-t-0 first:pt-0"
              >
                <legend className="font-semibold text-slate-900">{section.heading}</legend>
                {section.heading === 'Pricing & Order' && (
                  <ProductPricingEditor
                    initial={initial}
                    state={state}
                    error={fieldErrors.manualCatalogPricing}
                    onChange={(patch) => setState((current) => ({ ...current, ...patch }))}
                    onValidityChange={setPricingInvalid}
                  />
                )}
                {section.heading !== 'Pricing & Order' &&
                  section.fields.map((field) =>
                    field.name === 'category' && state.productFamily !== 'headphones' ? null : (
                      <Field
                        key={field.name}
                        field={
                          field.name === 'category'
                            ? { ...field, label: 'Headphone type (optional)' }
                            : field
                        }
                        value={state[field.name]}
                        error={fieldErrors[field.name]}
                        onBusyChange={field.name === 'imageIds' ? setImageBusy : undefined}
                        onValidityChange={
                          field.name === 'manualCatalogPricing' ? setPricingInvalid : undefined
                        }
                        onChange={(value) => setField(field.name, value)}
                      />
                    ),
                  )}
                {section.heading === 'Media' && sourcePreviewUrl && (
                  <div className="rounded-lg border border-dashed border-slate-300 p-3">
                    <div className="flex items-center gap-3">
                      <img
                        src={sourcePreviewUrl}
                        alt="Alibaba source preview"
                        referrerPolicy="no-referrer"
                        className="h-12 w-12 rounded-md object-cover"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-slate-500">
                          Alibaba source gallery · {sourcePreviewUrls.length} images
                        </p>
                        <button
                          type="button"
                          disabled={sourceImageBusy || imageBusy}
                          onClick={() => void importSourceGallery()}
                          className="mt-1 text-sm font-medium text-brand-700 hover:text-brand-900 disabled:opacity-50"
                        >
                          {sourceImageBusy ? 'Importing…' : 'Import source gallery'}
                        </button>
                      </div>
                    </div>
                    {sourceImageNotice && (
                      <p className="mt-2 text-xs text-slate-600" aria-live="polite">
                        {sourceImageNotice}
                      </p>
                    )}
                  </div>
                )}
              </fieldset>
            ))}
            {initial && needsCategoryReview(initial) && (
              <p
                role="alert"
                className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
              >
                Alibaba changed this product’s source category. Confirm the website Product Family
                above and save before publishing. Synchronization has kept your existing assignment.
              </p>
            )}
            {readOnlyFields.length > 0 && (
              <section
                aria-labelledby="alibaba-source-heading"
                className="border-t border-slate-200 pt-4"
              >
                <h3 id="alibaba-source-heading" className="font-semibold text-slate-900">
                  Alibaba Source
                </h3>
                <dl className="mt-3 space-y-2 text-sm">
                  {readOnlyFields.map((field) => (
                    <div key={field.label} className="flex justify-between gap-4">
                      <dt className="text-slate-500">{field.label}</dt>
                      <dd className="min-w-0 break-words text-right text-slate-800">
                        {field.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {editableFields.map((field) => (
              <Field
                key={field.name}
                field={field}
                value={state[field.name]}
                onChange={(value) => setField(field.name, value)}
              />
            ))}
          </div>
        )}

        <output data-product-form-announcement className="sr-only" aria-live="polite">
          {fieldAnnouncement}
        </output>

        {aggregateError && (
          <p className="mt-4 text-sm text-red-600" role="alert">
            {aggregateError}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => void cancelWithCandidateCleanup()}
            disabled={sourceImageBusy}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || imageBusy || sourceImageBusy || pricingInvalid}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {imageBusy ? 'Waiting for uploads…' : submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function Field({
  field,
  value,
  error,
  onBusyChange,
  onValidityChange,
  onChange,
}: {
  field: FieldDef;
  value: string | boolean;
  error?: string;
  onBusyChange?: (busy: boolean) => void;
  onValidityChange?: (invalid: boolean) => void;
  onChange: (value: string | boolean) => void;
}) {
  const label = (
    <label className="block text-sm font-medium text-slate-700" htmlFor={field.name}>
      {field.label}
      {field.required && <span className="text-red-500"> *</span>}
    </label>
  );
  const inputClass =
    'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900';
  const describedBy = error ? `${field.name}-error` : undefined;
  const fieldError = error ? (
    <p id={`${field.name}-error`} className="mt-1 text-xs text-red-600">
      {error}
    </p>
  ) : null;

  // Images are managed inline with a visual uploader rather than raw JSON.
  if (field.name === 'imageIds') {
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(String(value || '[]'));
      if (Array.isArray(parsed)) ids = parsed.map(String);
    } catch {
      ids = [];
    }
    return (
      <div>
        {label}
        <div className="mt-1.5">
          <ImageManager
            value={ids}
            inputId={field.name}
            maxItems={field.maxItems}
            errorId={describedBy}
            onBusyChange={onBusyChange}
            onChange={(next) => onChange(JSON.stringify(next))}
          />
        </div>
        {fieldError}
      </div>
    );
  }

  if (field.name === 'manualCatalogPricing') {
    return (
      <QuantityTierPricingEditor
        value={String(value)}
        error={error}
        onValidityChange={onValidityChange}
        onChange={(next) => onChange(next)}
      />
    );
  }

  if (field.type === 'boolean') {
    return (
      <div>
        <div className="flex items-center gap-2">
          <input
            id={field.name}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={describedBy}
          />
          <label htmlFor={field.name} className="text-sm font-medium text-slate-700">
            {field.label}
          </label>
        </div>
        {fieldError}
      </div>
    );
  }

  if (field.type === 'select') {
    return (
      <Select
        id={field.name}
        label={field.name === 'productFamily' ? 'Website main category' : field.label}
        options={
          field.name === 'productFamily'
            ? Object.entries(ADMIN_PRODUCT_FAMILY_LABELS).map(([value, label]) => ({
                value,
                label,
              }))
            : (field.options ?? [])
        }
        value={String(value)}
        placeholder="Select…"
        required={field.required}
        error={error}
        triggerClassName="mt-1"
        onChange={onChange}
      />
    );
  }

  if (field.type === 'text' || field.type === 'json') {
    return (
      <div>
        {label}
        <textarea
          id={field.name}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          rows={field.type === 'json' ? 5 : 3}
          placeholder={field.placeholder}
          className={`${inputClass} font-${field.type === 'json' ? 'mono' : 'sans'}`}
          required={field.required}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={describedBy}
        />
        {fieldError}
      </div>
    );
  }

  // File reference: bytes live in the `files` collection (CloudBase Storage).
  // Production has no public `/api/files/:id`, so download is the authenticated
  // `getOemFileDownloadUrl` action (short-TTL temp URL), handled by
  // `FileDownloadLink`. Shown read-only here (re-upload is not supported in the
  // admin edit form).
  if (field.type === 'file') {
    const fileId = String(value || '');
    return (
      <div>
        {label}
        <div className="mt-1">
          {fileId ? (
            <FileDownloadLink id={fileId} />
          ) : (
            <span className="text-sm text-slate-400">No file attached</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      {label}
      <input
        id={field.name}
        type={field.type === 'number' ? 'number' : field.type === 'email' ? 'email' : 'text'}
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        className={inputClass}
        required={field.required}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={describedBy}
      />
      {fieldError}
    </div>
  );
}

/** Convert the string-based form state into typed values for the API. */
export function coerceValues(
  collection: CollectionDef,
  state: FormState,
  initial?: CollectionDoc,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of collection.fields) {
    if (field.readOnly || field.hideInForm) continue;
    const raw = state[field.name];

    // Restoring inheritance changes policy only, not the retained manual record.
    if (
      collection.name === 'products' &&
      state.catalogPricingMode === 'source' &&
      ['manualCatalogPricing', 'unitPrice', 'wholesalePrice', 'moq'].includes(field.name)
    )
      continue;

    if (
      collection.name === 'products' &&
      field.name === 'category' &&
      state.productFamily !== 'headphones'
    ) {
      if (
        typeof initial?.category === 'string' &&
        (LEGACY_HEADPHONES_CATEGORY_OPTIONS as readonly string[]).includes(initial.category)
      ) {
        values.category = '';
      }
      continue;
    }

    if (collection.name === 'products' && field.name === 'manualCatalogPricing') {
      const str = String(raw ?? '').trim();
      if (str) {
        values.manualCatalogPricing = JSON.parse(str);
      } else if (initial && initial.manualCatalogPricing !== undefined) {
        values.manualCatalogPricing = null;
      }
      continue;
    }

    if (field.type === 'boolean') {
      values[field.name] = Boolean(raw);
      continue;
    }

    const str = String(raw ?? '').trim();
    if (str === '') {
      if (field.required) throw new Error(`${field.label} is required`);
      continue; // omit empty optional fields
    }

    if (field.type === 'number') {
      const num = Number(str);
      if (!Number.isFinite(num)) throw new Error(`${field.label} must be a finite number`);
      values[field.name] = num;
    } else if (field.type === 'json') {
      try {
        values[field.name] = JSON.parse(str);
      } catch {
        throw new Error(`${field.label} must be valid JSON`);
      }
    } else {
      values[field.name] = str;
    }
  }
  return values;
}
