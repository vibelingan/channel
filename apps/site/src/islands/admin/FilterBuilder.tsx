import type { CollectionDef, FieldDef, FilterModel } from '@vibelingan-channel/shared';
import {
  type FilterClause,
  type FilterCombinator,
  type FilterOperator,
  isValuelessOperator,
  operatorLabel,
  operatorsForType,
} from '@vibelingan-channel/shared';
import { useState } from 'react';

interface Props {
  collection: CollectionDef;
  /** The filter currently applied to the grid (for display / reset). */
  applied: FilterModel | null;
  onApply: (filter: FilterModel | null) => void;
}

/** Fields a user may filter on (skip opaque blobs and server-managed fields). */
function filterableFields(collection: CollectionDef): FieldDef[] {
  return collection.fields.filter((f) => f.type !== 'json' && f.name !== 'passwordHash');
}

function defaultClause(fields: FieldDef[]): FilterClause {
  const field = fields[0];
  const ops = operatorsForType(field?.type ?? 'string');
  return { field: field?.name ?? '', op: ops[0] ?? 'contains', value: '' };
}

/**
 * Visual query builder: add/remove field·operator·value rows joined by a single
 * AND/OR. Produces a `FilterModel` the server translates to wx-server-sdk (cloud)
 * or evaluates in memory (local JSON adapter).
 */
export function FilterBuilder({ collection, applied, onApply }: Props) {
  const fields = filterableFields(collection);
  const [open, setOpen] = useState(false);
  const [combinator, setCombinator] = useState<FilterCombinator>(applied?.combinator ?? 'and');
  const [clauses, setClauses] = useState<FilterClause[]>(
    applied && applied.clauses.length > 0 ? applied.clauses : [defaultClause(fields)],
  );

  const activeCount = applied?.clauses.length ?? 0;

  function fieldDef(name: string): FieldDef | undefined {
    return fields.find((f) => f.name === name);
  }

  function updateClause(index: number, patch: Partial<FilterClause>) {
    setClauses((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  function changeField(index: number, name: string) {
    const def = fieldDef(name);
    const ops = operatorsForType(def?.type ?? 'string');
    const current = clauses[index];
    const op = current && ops.includes(current.op) ? current.op : (ops[0] ?? 'contains');
    updateClause(index, { field: name, op, value: '' });
  }

  function addClause() {
    setClauses((prev) => [...prev, defaultClause(fields)]);
  }

  function removeClause(index: number) {
    setClauses((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  function apply() {
    const usable = clauses.filter(
      (c) => c.field && (isValuelessOperator(c.op) || String(c.value ?? '').trim() !== ''),
    );
    if (usable.length === 0) {
      onApply(null);
      setOpen(false);
      return;
    }
    onApply({ combinator, clauses: usable.map((c) => normalizeValue(c, fieldDef(c.field))) });
    setOpen(false);
  }

  function clearAll() {
    setClauses([defaultClause(fields)]);
    setCombinator('and');
    onApply(null);
    setOpen(false);
  }

  /** Remove a single applied clause directly from the breadcrumb list. */
  function removeAppliedClause(index: number) {
    if (!applied) return;
    const next = applied.clauses.filter((_, i) => i !== index);
    if (next.length === 0) {
      onApply(null);
      setClauses([defaultClause(fields)]);
      return;
    }
    const nextModel: FilterModel = { combinator: applied.combinator, clauses: next };
    onApply(nextModel);
    setClauses(next);
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {applied?.clauses.map((clause, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: applied clauses have no stable id
        <span key={index} className="flex items-center gap-1.5">
          {index > 0 && (
            <span className="text-[0.65rem] font-semibold uppercase tracking-wide text-slate-400">
              {applied.combinator}
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-100 py-1 pl-2.5 pr-1 text-xs text-slate-700">
            <span>{describeClause(clause, fieldDef(clause.field))}</span>
            <button
              type="button"
              onClick={() => removeAppliedClause(index)}
              aria-label="Remove filter"
              className="grid h-4 w-4 place-items-center rounded-full text-slate-400 hover:bg-slate-300 hover:text-slate-700"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                className="h-3 w-3"
              >
                <path d="M6 6l8 8M14 6l-8 8" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            </button>
          </span>
        </span>
      ))}

      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ${
            activeCount > 0
              ? 'border-slate-900 bg-slate-900 text-white hover:bg-slate-700'
              : 'border-slate-300 text-slate-700 hover:bg-slate-100'
          }`}
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
            <path d="M3 4a1 1 0 0 1 1-1h12a1 1 0 0 1 .8 1.6l-4.55 6.07A1 1 0 0 0 12 11.3V16a1 1 0 0 1-1.45.9l-2-1A1 1 0 0 1 8 15v-3.7a1 1 0 0 0-.25-.63L3.2 4.6A1 1 0 0 1 3 4Z" />
          </svg>
          {activeCount > 0 ? 'Add filter' : 'Filters'}
        </button>

        {open && (
          <div className="absolute left-0 z-20 mt-2 w-[34rem] max-w-[90vw] rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">Build a query</h3>
              {clauses.length > 1 && (
                <div className="inline-flex overflow-hidden rounded-lg border border-slate-300 text-xs">
                  <button
                    type="button"
                    onClick={() => setCombinator('and')}
                    className={`px-3 py-1 font-semibold ${combinator === 'and' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
                  >
                    Match all (AND)
                  </button>
                  <button
                    type="button"
                    onClick={() => setCombinator('or')}
                    className={`px-3 py-1 font-semibold ${combinator === 'or' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
                  >
                    Match any (OR)
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-2">
              {clauses.map((clause, index) => {
                const def = fieldDef(clause.field);
                const ops = operatorsForType(def?.type ?? 'string');
                const showValue = !isValuelessOperator(clause.op);
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id
                  <div key={index} className="flex items-center gap-2">
                    <select
                      value={clause.field}
                      onChange={(e) => changeField(index, e.target.value)}
                      className="w-40 rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-slate-900"
                    >
                      {fields.map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                    <select
                      value={clause.op}
                      onChange={(e) =>
                        updateClause(index, { op: e.target.value as FilterOperator })
                      }
                      className="w-36 rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-slate-900"
                    >
                      {ops.map((op) => (
                        <option key={op} value={op}>
                          {operatorLabel(op)}
                        </option>
                      ))}
                    </select>
                    {showValue ? (
                      <ValueInput
                        field={def}
                        value={clause.value}
                        onChange={(v) => updateClause(index, { value: v })}
                      />
                    ) : (
                      <div className="flex-1" />
                    )}
                    <button
                      type="button"
                      onClick={() => removeClause(index)}
                      disabled={clauses.length === 1}
                      aria-label="Remove condition"
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-red-600 disabled:opacity-30"
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className="h-4 w-4"
                      >
                        <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="2" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              onClick={addClause}
              className="mt-3 text-sm font-medium text-brand-700 hover:text-brand-900"
            >
              + Add condition
            </button>

            <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
              <button
                type="button"
                onClick={clearAll}
                className="text-sm font-medium text-slate-500 hover:text-slate-700"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={apply}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
              >
                Apply filters
              </button>
            </div>
          </div>
        )}
      </div>

      {applied && applied.clauses.length > 0 && (
        <button
          type="button"
          onClick={clearAll}
          className="ml-0.5 text-xs font-medium text-slate-500 hover:text-slate-700"
        >
          Clear all
        </button>
      )}
    </div>
  );
}

/** Render an applied clause as a short, human-readable breadcrumb label. */
function describeClause(clause: FilterClause, field: FieldDef | undefined): string {
  const label = field?.label ?? clause.field;
  if (isValuelessOperator(clause.op)) {
    return `${label} ${operatorLabel(clause.op)}`;
  }
  let value = clause.value;
  if (typeof value === 'boolean') value = value ? 'Yes' : 'No';
  return `${label} ${operatorLabel(clause.op)} ${String(value ?? '')}`.trim();
}

function ValueInput({
  field,
  value,
  onChange,
}: {
  field: FieldDef | undefined;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const str = value === undefined || value === null ? '' : String(value);
  const cls =
    'flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-slate-900';

  if (field?.type === 'select') {
    return (
      <select value={str} onChange={(e) => onChange(e.target.value)} className={cls}>
        <option value="">Select…</option>
        {field.options?.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (field?.type === 'boolean') {
    return (
      <select value={str} onChange={(e) => onChange(e.target.value === 'true')} className={cls}>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }
  if (field?.type === 'number') {
    return (
      <input
        type="number"
        value={str}
        onChange={(e) => onChange(e.target.value)}
        className={cls}
        placeholder="Value"
      />
    );
  }
  return (
    <input
      type="text"
      value={str}
      onChange={(e) => onChange(e.target.value)}
      className={cls}
      placeholder="Value"
    />
  );
}

/** Coerce a string-bound value to the field's underlying type before sending. */
function normalizeValue(clause: FilterClause, field: FieldDef | undefined): FilterClause {
  if (isValuelessOperator(clause.op)) {
    return { field: clause.field, op: clause.op };
  }
  if (field?.type === 'number') {
    const n = Number(clause.value);
    return { ...clause, value: Number.isNaN(n) ? clause.value : n };
  }
  if (field?.type === 'boolean') {
    return { ...clause, value: clause.value === true || clause.value === 'true' };
  }
  return clause;
}
