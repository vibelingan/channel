import { useEffect, useId, useState } from 'react';

/** The page a typed number asks for, kept within 1…pageCount; null when it is not a number. */
export function requestedPage(input: string, pageCount: number): number | null {
  const value = Number.parseInt(input.trim(), 10);
  if (!Number.isFinite(value)) return null;
  return Math.min(Math.max(1, pageCount), Math.max(1, value));
}

/** "Go to page [n] Go": type a page number to jump straight to it. */
export function PageJump({
  page,
  pageCount,
  onJump,
}: {
  page: number;
  pageCount: number;
  onJump: (page: number) => void;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState(String(page));
  useEffect(() => setDraft(String(page)), [page]);
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        const next = requestedPage(draft, pageCount);
        if (next === null) setDraft(String(page));
        else {
          setDraft(String(next));
          onJump(next);
        }
      }}
    >
      <label htmlFor={inputId} className="ml-2">
        Go to page
      </label>
      <input
        id={inputId}
        type="number"
        inputMode="numeric"
        min={1}
        max={pageCount}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="h-9 w-16 rounded-lg border border-slate-300 px-2 text-center tabular-nums text-slate-800"
      />
      <button type="submit" className="min-h-9 rounded-lg border border-slate-300 px-3 py-1.5">
        Go
      </button>
    </form>
  );
}
