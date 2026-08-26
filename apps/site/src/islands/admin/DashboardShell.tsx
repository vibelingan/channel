import { getCollection } from '@vibelingan-channel/shared';
import { useMemo, useState } from 'react';
import { canManageUsers, getUser } from '../../lib/session.ts';
import { CollectionView } from './CollectionView.tsx';
import { AlibabaCatalogSyncPage } from './alibaba-catalog-sync/AlibabaCatalogSyncPage.tsx';
import { CatalogImportPage } from './catalog-import/CatalogImportPage.tsx';
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
    <div className="flex min-h-screen min-w-0 max-w-full flex-col overflow-x-hidden lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col border-b border-slate-200 bg-white lg:w-60 lg:border-b-0 lg:border-r">
        <div className="border-b border-slate-200 px-5 py-4">
          <p className="text-sm font-semibold text-slate-900">Channel Admin</p>
          <p className="mt-0.5 text-xs capitalize text-slate-500">{role || 'member'}</p>
        </div>
        <nav className="flex gap-1 overflow-x-auto p-3 lg:block lg:flex-1 lg:space-y-1">
          {sections.map((s) => (
            <button
              type="button"
              key={s.collection}
              onClick={() => setActive(s.collection)}
              className={`min-h-11 shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm transition lg:w-full ${
                s.collection === active
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="flex gap-2 border-t border-slate-200 p-3 lg:block">
          <a
            href="/"
            className="min-h-11 flex-1 rounded-lg px-3 py-2 text-center text-sm text-slate-600 hover:bg-slate-100 lg:block lg:text-left"
          >
            ← Back to site
          </a>
          <button
            type="button"
            onClick={onLogout}
            className="min-h-11 flex-1 rounded-lg px-3 py-2 text-center text-sm text-slate-600 hover:bg-slate-100 lg:mt-1 lg:w-full lg:text-left"
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-auto">
        {section?.custom === 'alibaba-sync' ? (
          <div className="p-6">
            <AlibabaCatalogSyncPage />
          </div>
        ) : section?.custom === 'catalog-import' ? (
          <div className="p-6">
            <CatalogImportPage />
          </div>
        ) : section && collection ? (
          <CollectionView key={collection.name} collection={collection} section={section} />
        ) : (
          <p className="p-8 text-slate-500">No collections available.</p>
        )}
      </main>
    </div>
  );
}
