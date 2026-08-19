import type { CollectionDef, CollectionDoc, FieldDef } from '@vibelingan-channel/shared';
import { useState } from 'react';
import { FileDownloadLink } from './FileDownloadLink.tsx';
import { ImageManager } from './ImageManager.tsx';

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
      state[field.name] = raw === undefined ? '' : JSON.stringify(raw, null, 2);
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

  function setField(name: string, value: string | boolean) {
    setState((prev) => ({ ...prev, [name]: value }));
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLocalError('');
    try {
      const values = coerceValues(collection, state);
      onSubmit(values);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'Invalid input');
    }
  }

  const editableFields = collection.fields.filter((f) => !f.readOnly);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <form
        method="post"
        onSubmit={handleSubmit}
        className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-2xl bg-white p-6 shadow-xl"
      >
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>

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

        {(localError || error) && (
          <p className="mt-4 text-sm text-red-600">{localError || error?.message}</p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: string | boolean;
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
            onChange={(next) => onChange(JSON.stringify(next))}
          />
        </div>
      </div>
    );
  }

  if (field.type === 'boolean') {
    return (
      <div className="flex items-center gap-2">
        <input
          id={field.name}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300"
        />
        <label htmlFor={field.name} className="text-sm font-medium text-slate-700">
          {field.label}
        </label>
      </div>
    );
  }

  if (field.type === 'select') {
    return (
      <div>
        {label}
        <select
          id={field.name}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
          required={field.required}
        >
          <option value="">Select…</option>
          {field.options?.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
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
        />
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
      />
    </div>
  );
}

/** Convert the string-based form state into typed values for the API. */
function coerceValues(collection: CollectionDef, state: FormState): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of collection.fields) {
    if (field.readOnly) continue;
    const raw = state[field.name];

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
      if (Number.isNaN(num)) throw new Error(`${field.label} must be a number`);
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
