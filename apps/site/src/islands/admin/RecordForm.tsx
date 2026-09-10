import {
  type CollectionDef,
  type CollectionDoc,
  type FieldDef,
  LEGACY_HEADPHONES_CATEGORY_OPTIONS,
  PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT,
  type ProductFamily,
  needsCategoryReview,
} from '@vibelingan-channel/shared';
import { useRef, useState } from 'react';
import { Select } from '../../components/form/Select.tsx';
import { FileDownloadLink } from './FileDownloadLink.tsx';
import { ImageManager } from './ImageManager.tsx';
import { ImageViewer, PreviewImageContent } from './ImageViewer.tsx';
import { ProductPricingEditor } from './ProductPricingEditor.tsx';
import { QuantityTierPricingEditor } from './QuantityTierPricingEditor.tsx';
import {
  importAlibabaSourceImage,
  removeAlibabaImportedImage,
} from './alibaba-catalog-sync/alibaba-api.ts';
import { importAlibabaGallery } from './alibaba-gallery-import.ts';
import { alibabaSourcePreviewInfo, alibabaSourcePreviewUrls } from './alibaba-source-preview.ts';
import { AdminApiError } from './api.ts';
import { ADMIN_PRODUCT_FAMILY_LABELS } from './product-family-tabs.ts';
import { useModalDialog } from './use-modal-dialog.ts';

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
  { heading: 'Media', fields: ['imageIds', 'descriptionImageIds'] },
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
  const [descriptionImageBusy, setDescriptionImageBusy] = useState(false);
  const [sourceImageBusy, setSourceImageBusy] = useState(false);
  const [sourceImageNotice, setSourceImageNotice] = useState('');
  const [newSourceImageIds, setNewSourceImageIds] = useState<string[]>([]);
  const [pricingInvalid, setPricingInvalid] = useState(false);
  const [discardRequested, setDiscardRequested] = useState(false);
  const [sourcePreviewId, setSourcePreviewId] = useState<string>();
  const dialogRef = useModalDialog();
  const initialStateRef = useRef(state);
  const cancelInFlight = useRef(false);
  const mediaBusy = imageBusy || descriptionImageBusy || sourceImageBusy;
  const busy = submitting || mediaBusy;
  const dirty = JSON.stringify(state) !== JSON.stringify(initialStateRef.current);

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
    if (busy || pricingInvalid || discardRequested) return;
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
  const descriptionPreview = alibabaSourcePreviewInfo(
    initial?.alibabaDescriptionImageUrls,
    PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT,
  );
  const descriptionPreviewUrls = descriptionPreview.urls;
  const descriptionSourceOverflow = descriptionPreview.total > descriptionPreviewUrls.length;

  async function importSourceGallery(description = false) {
    const sourceUrls = description ? descriptionPreviewUrls : sourcePreviewUrls;
    const field = description ? 'descriptionImageIds' : 'imageIds';
    const maxItems = description ? 18 : 9;
    if (!sourceUrls.length || sourceImageBusy) return;
    setSourceImageBusy(true);
    setSourceImageNotice('');
    try {
      let currentIds: string[] = [];
      try {
        const parsed: unknown = JSON.parse(String(state[field] || '[]'));
        if (Array.isArray(parsed)) {
          currentIds = parsed.filter((value): value is string => typeof value === 'string');
        }
      } catch {
        currentIds = [];
      }
      const result = await importAlibabaGallery({
        sourceUrls,
        maxItems,
        imageIds: currentIds,
        importImage: importAlibabaSourceImage,
        onProgress: (ids) => setField(field, JSON.stringify(ids)),
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
                `${result.remaining} source images not imported${result.imageIds.length >= maxItems ? ': the image limit is reached' : ': the import stopped; check the error before retrying'}.`,
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
    if (busy || cancelInFlight.current) return;
    cancelInFlight.current = true;
    setSourceImageBusy(true);
    await Promise.allSettled(newSourceImageIds.map(removeAlibabaImportedImage));
    onCancel();
  }

  function requestClose() {
    if (busy) return;
    if (dirty) setDiscardRequested(true);
    else void cancelWithCandidateCleanup();
  }

  const editableFields = productEditableFields(collection);
  const sections = productFormSections(collection);
  const fieldErrors = collection.name === 'products' ? productFormErrorTargets(error) : {};
  const aggregateError =
    localError || (Object.keys(fieldErrors).length === 0 ? error?.message : '');

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="record-form-title"
      onCancel={(event) => {
        event.preventDefault();
        if (discardRequested) setDiscardRequested(false);
        else requestClose();
      }}
      className={`m-auto max-h-[92dvh] w-[calc(100%-2rem)] overflow-hidden rounded-2xl border-0 bg-white p-0 shadow-xl backdrop:bg-slate-900/40 ${collection.name === 'products' ? 'max-w-6xl' : 'max-w-lg'}`}
    >
      <form method="post" onSubmit={handleSubmit} className="flex max-h-[92dvh] min-w-0 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 px-5 py-3">
          <h2 id="record-form-title" className="text-lg font-semibold text-slate-900">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close editor"
            onClick={requestClose}
            disabled={busy}
            className="min-h-11 min-w-11 rounded-lg text-xl text-slate-600 hover:bg-slate-100 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            ×
          </button>
        </header>

        <div
          data-record-form-body
          className="min-h-0 overflow-y-auto overscroll-contain p-5 sm:p-6"
        >
          {sections.length > 0 ? (
            <div className="grid min-w-0 gap-6 lg:grid-cols-2">
              {sections.map((section) => (
                <fieldset
                  key={section.heading}
                  disabled={submitting || sourceImageBusy || discardRequested}
                  className={`min-w-0 space-y-4 rounded-xl border border-slate-200 p-4 ${
                    section.heading === 'Identity'
                      ? 'lg:col-start-1 lg:row-start-1'
                      : section.heading === 'Content'
                        ? 'lg:col-start-1 lg:row-start-2'
                        : section.heading === 'Media'
                          ? 'lg:col-start-2 lg:row-start-1'
                          : section.heading === 'Pricing & Order'
                            ? 'lg:col-start-2 lg:row-start-2'
                            : 'lg:col-span-2'
                  }`}
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
                  <div
                    className={
                      section.heading === 'Media' ? 'min-w-0' : 'grid min-w-0 gap-4 sm:grid-cols-2'
                    }
                  >
                    {section.heading !== 'Pricing & Order' &&
                      section.fields.map((field) =>
                        field.name === 'category' && state.productFamily !== 'headphones' ? null : (
                          <div
                            key={field.name}
                            className={`min-w-0 ${['name', 'description', 'imageIds'].includes(field.name) ? 'sm:col-span-2' : ''}`}
                          >
                            <Field
                              key={field.name}
                              field={
                                field.name === 'imageIds'
                                  ? { ...field, label: 'Product images' }
                                  : field.name === 'category'
                                    ? { ...field, label: 'Headphone type (optional)' }
                                    : field
                              }
                              value={state[field.name]}
                              error={fieldErrors[field.name]}
                              onBusyChange={
                                field.name === 'imageIds'
                                  ? setImageBusy
                                  : field.name === 'descriptionImageIds'
                                    ? setDescriptionImageBusy
                                    : undefined
                              }
                              onValidityChange={
                                field.name === 'manualCatalogPricing'
                                  ? setPricingInvalid
                                  : undefined
                              }
                              onChange={(value) => setField(field.name, value)}
                            />
                          </div>
                        ),
                      )}
                  </div>
                  {section.heading === 'Media' && sourcePreviewUrl && (
                    <div className="rounded-lg border border-dashed border-slate-300 p-3">
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-slate-500">
                            Alibaba source gallery · {sourcePreviewUrls.length} images
                          </p>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void importSourceGallery()}
                            className="mt-1 text-sm font-medium text-brand-700 hover:text-brand-900 disabled:opacity-50"
                          >
                            {sourceImageBusy ? 'Importing…' : 'Import source gallery'}
                          </button>
                        </div>
                      </div>
                      <div
                        className="mt-3 flex flex-wrap gap-2"
                        aria-label="Alibaba source gallery"
                      >
                        {sourcePreviewUrls.map((url, index) => (
                          <button
                            key={url}
                            type="button"
                            aria-label={`Preview source image ${index + 1}`}
                            onClick={() => setSourcePreviewId(url)}
                            className="h-16 w-16 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 hover:border-brand-600 focus-visible:ring-2 focus-visible:ring-brand-600"
                          >
                            <PreviewImageContent
                              src={url}
                              alt=""
                              className="h-full w-full object-contain"
                            />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {section.heading === 'Media' && descriptionPreviewUrls.length > 0 && (
                    <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-3">
                      <p className="text-xs text-slate-500">
                        Source description · {descriptionPreview.total} images (separate from the
                        product gallery)
                      </p>
                      {descriptionSourceOverflow && (
                        <p className="mt-1 text-xs text-slate-600">
                          Up to {descriptionPreviewUrls.length} description images can be saved.
                          Import the first {descriptionPreviewUrls.length}, then review or remove
                          them in Description images. The remaining source images are not imported.
                        </p>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void importSourceGallery(true)}
                        className="mt-2 min-h-11 text-sm font-medium text-brand-700 disabled:opacity-50"
                      >
                        {sourceImageBusy
                          ? 'Importing…'
                          : descriptionSourceOverflow
                            ? `Import first ${descriptionPreviewUrls.length} description images`
                            : 'Import description images'}
                      </button>
                    </div>
                  )}
                  {section.heading === 'Media' && sourceImageNotice && (
                    <output className="mt-2 block text-xs text-slate-600">
                      {sourceImageNotice}
                    </output>
                  )}
                </fieldset>
              ))}
              {initial && needsCategoryReview(initial) && (
                <p
                  role="alert"
                  className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 lg:col-span-2"
                >
                  Alibaba changed this product’s source category. Confirm the website Product Family
                  above and save before publishing. Synchronization has kept your existing
                  assignment.
                </p>
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
        </div>

        <output data-product-form-announcement className="sr-only" aria-live="polite">
          {fieldAnnouncement}
        </output>

        <footer
          data-record-form-actions
          className="shrink-0 border-t border-slate-200 bg-white px-5 py-3"
        >
          {aggregateError && (
            <p data-record-form-error className="mb-3 text-sm text-red-600" role="alert">
              {aggregateError}
            </p>
          )}

          {discardRequested ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-slate-700">Discard your unsaved changes?</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setDiscardRequested(false)}
                  className="min-h-11 rounded-lg border border-slate-300 px-3 text-sm focus-visible:ring-2 focus-visible:ring-brand-600"
                >
                  Keep editing
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void cancelWithCandidateCleanup()}
                  className="min-h-11 rounded-lg bg-red-700 px-3 text-sm text-white disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-brand-600"
                >
                  Discard changes
                </button>
              </div>
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={requestClose}
                disabled={busy}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || pricingInvalid}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
              >
                {mediaBusy ? 'Waiting for uploads…' : submitting ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}
        </footer>
      </form>
      {sourcePreviewId && (
        <ImageViewer
          images={sourcePreviewUrls.map((url, index) => ({
            id: url,
            src: url,
            label: `Source image ${index + 1}`,
          }))}
          initialId={sourcePreviewId}
          onClose={() => setSourcePreviewId(undefined)}
        />
      )}
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
  if (field.name === 'imageIds' || field.name === 'descriptionImageIds') {
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
            purpose={field.name === 'descriptionImageIds' ? 'description' : 'gallery'}
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
