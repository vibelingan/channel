import type { CategoryApply, CategoryPreviewRow } from '@vibelingan-channel/shared';
import { useEffect, useRef, useState } from 'react';
import { manageCategoryAssignments } from '../api.ts';
import { ADMIN_PRODUCT_FAMILY_LABELS as names } from '../product-family-tabs.ts';

const button =
  'rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50 disabled:opacity-50';

/** No writes on mount. Each batch is explicit, bounded and retryable. */
export function AlibabaCategoryAssignment({ onApplied }: { onApplied: () => void }) {
  const [rows, setRows] = useState<CategoryPreviewRow[]>([]);
  const [pending, setPending] = useState<CategoryApply[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [hasPreview, setHasPreview] = useState(false);
  const alive = useRef(true);
  const lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function act(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error ? e.message : 'Operation failed. Retry or refresh the preview.',
        );
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function configure() {
    setRows([]);
    setPending([]);
    setHasPreview(false);
    const issues: string[] = [];
    let installed = 0;
    for (let offset: number | null = 0; offset !== null && alive.current; ) {
      const response = await manageCategoryAssignments({ kind: 'configure', offset });
      if (response.kind !== 'configure') throw new Error('Unexpected category response');
      for (const row of response.results) {
        if (row.status === 'configured') installed++;
        else issues.push(`${row.id}: ${row.status}`);
      }
      if (response.nextOffset !== null && response.nextOffset <= offset)
        throw new Error('Invalid category cursor');
      offset = response.nextOffset;
    }
    if (!alive.current) return;
    setNotice(
      `${installed} approved mapping rules installed or already present. No products were changed.`,
    );
    if (issues.length) setError(`Rules needing attention: ${issues.join('; ')}`);
  }
  async function preview() {
    setRows([]);
    setPending([]);
    setHasPreview(false);
    setNotice('Checking existing products…');
    const all: CategoryPreviewRow[] = [];
    let after: string | undefined;
    for (let page = 0; page < 200 && alive.current; page++) {
      const response = await manageCategoryAssignments({
        kind: 'preview',
        ...(after ? { after } : {}),
      });
      if (response.kind !== 'preview') throw new Error('Unexpected category response');
      all.push(...response.rows);
      if (response.nextAfter === null) {
        if (!alive.current) return;
        setRows(all);
        setPending(
          all.flatMap((row) =>
            row.command ? [{ ...row.command, operationId: crypto.randomUUID() }] : [],
          ),
        );
        setHasPreview(true);
        setNotice('Preview ready. Only eligible unpublished, unclassified products will change.');
        return;
      }
      if (after && response.nextAfter <= after) throw new Error('Invalid category cursor');
      after = response.nextAfter;
    }
    if (alive.current) throw new Error('Preview limit reached. No product changes were made.');
  }
  async function apply() {
    let remaining = [...pending];
    let applied = 0;
    const issues: string[] = [];
    for (let offset = 0; offset < pending.length && alive.current; offset += 10) {
      const batch = pending.slice(offset, offset + 10);
      const response = await manageCategoryAssignments({ kind: 'apply', commands: batch });
      if (
        response.kind !== 'apply' ||
        response.results.length !== batch.length ||
        response.results.some((row, i) => row.id !== batch[i]?.productId)
      )
        throw new Error('Incomplete response. Retry safely using the same operation references.');
      const done = new Set(
        response.results
          .filter((row) => row.status === 'applied' || row.status === 'replayed')
          .map((row) => row.id),
      );
      applied += done.size;
      remaining = remaining.filter((row) => !done.has(row.productId));
      issues.push(
        ...response.results
          .filter((row) => !done.has(row.id))
          .map((row) => `${row.id}: ${row.status}`),
      );
      if (alive.current) {
        setPending(remaining);
        setNotice(
          `${applied} product classifications saved. ${remaining.length} remaining. No products published.`,
        );
      }
    }
    if (!alive.current) return;
    onApplied();
    if (issues.length)
      setError(
        `Not applied — refresh preview to resolve conflicts; failed items can be retried: ${issues.join('; ')}`,
      );
  }
  const eligible = rows.filter((row) => row.status === 'ready');
  const deferred = rows.filter((row) => row.status === 'deferred').length;
  return (
    <section
      className="rounded-lg border border-slate-200 bg-white p-5"
      aria-labelledby="category-assignment-heading"
    >
      <h2 id="category-assignment-heading" className="text-lg font-semibold text-slate-900">
        Website category assignment
      </h2>
      <p className="mt-2 text-sm text-slate-600">
        Use the approved mapping to Headphones, AI Gadgets, Toys and Misc. Existing assignments and
        published products are protected. Deferred products are left unchanged.
      </p>
      <p className="mt-2 text-sm text-slate-600">
        Mixed source categories require a product-level decision. Installing rules does not classify
        new mixed-category products or publish anything.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => void act(configure)}
        >
          Install approved mapping rules
        </button>
        <button type="button" className={button} disabled={busy} onClick={() => void act(preview)}>
          Preview category assignments
        </button>
        <button
          type="button"
          className={`${button} bg-slate-900 !text-white hover:bg-slate-800`}
          disabled={busy || pending.length === 0}
          onClick={() => void act(apply)}
        >
          Apply {pending.length} reviewed assignments
        </button>
      </div>
      <output className="mt-3 block text-sm text-slate-600">
        {busy ? 'Working… ' : ''}
        {notice}
      </output>
      {error && (
        <p className="mt-3 break-words text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      {hasPreview && (
        <>
          <p className="mt-3 text-sm text-slate-700">
            {Object.entries(names)
              .map(
                ([key, label]) =>
                  `${label}: ${eligible.filter((row) => row.target === key).length}`,
              )
              .join(' · ')}{' '}
            · Deferred: {deferred} · Rule conflicts:{' '}
            {rows.filter((row) => row.status === 'rule-conflict').length}
          </p>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer font-medium text-slate-900">
              Review product-level changes ({eligible.length})
            </summary>
            <div className="mt-2 max-h-80 overflow-auto">
              <table className="w-full text-left text-slate-700">
                <thead>
                  <tr>
                    <th className="p-2">Product</th>
                    <th className="p-2">Alibaba category ID</th>
                    <th className="p-2">Website category</th>
                  </tr>
                </thead>
                <tbody>
                  {eligible.map((row) => (
                    <tr key={row.productId} className="border-t border-slate-100">
                      <td className="p-2">
                        {row.name}
                        <span className="block text-xs text-slate-500">{row.productId}</span>
                      </td>
                      <td className="p-2">{row.sourceCategoryId}</td>
                      <td className="p-2">{row.target ? names[row.target] : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
