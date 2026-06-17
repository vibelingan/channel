import { getCollection } from '@vibelingan-channel/shared';
import { useMemo, useState } from 'react';
import { canManageUsers, getUser } from '../../lib/session.ts';
import { CollectionView } from './CollectionView.tsx';
import { DASHBOARD_SECTIONS, type DashboardSection } from './sections.ts';

export function DashboardShell({ onLogout }: { onLogout: () => void }) {
  const role = getUser()?.role ?? '';

  // Show only sections the role may use, and that map to a real collection.
  const sections = useMemo<DashboardSection[]>(
    () =>
      DASHBOARD_SECTIONS.filter(
        (s) => getCollection(s.collection) && (!s.adminOnly || canManageUsers(role)),
      ),
    [role],
  );

  const [active, setActive] = useState(sections[0]?.collection ?? '');
  const section = sections.find((s) => s.collection === active);
  const collection = section ? getCollection(section.collection) : undefined;

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-5 py-4">
          <p className="text-sm font-semibold text-slate-900">Channel Admin</p>
          <p className="mt-0.5 text-xs capitalize text-slate-500">{role || 'member'}</p>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {sections.map((s) => (
            <button
              type="button"
              key={s.collection}
              onClick={() => setActive(s.collection)}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm transition ${
                s.collection === active
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="border-t border-slate-200 p-3">
          <a
            href="/"
            className="block rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
          >
            ← Back to site
          </a>
          <button
            type="button"
            onClick={onLogout}
            className="mt-1 w-full rounded-lg px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-100"
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        {section && collection ? (
          <CollectionView key={collection.name} collection={collection} section={section} />
        ) : (
          <p className="p-8 text-slate-500">No collections available.</p>
        )}
      </main>
    </div>
  );
}
