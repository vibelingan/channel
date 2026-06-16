import { COLLECTIONS } from '@vibelingan-channel/shared';
import { useState } from 'react';
import { CollectionView } from './CollectionView.tsx';

export function DashboardShell({ onLogout }: { onLogout: () => void }) {
  const [active, setActive] = useState(COLLECTIONS[0]?.name ?? '');
  const current = COLLECTIONS.find((c) => c.name === active);

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-5 py-4">
          <p className="text-sm font-semibold text-slate-900">Channel Admin</p>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {COLLECTIONS.map((collection) => (
            <button
              type="button"
              key={collection.name}
              onClick={() => setActive(collection.name)}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm transition ${
                collection.name === active
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              {collection.label}
            </button>
          ))}
        </nav>
        <div className="border-t border-slate-200 p-3">
          <button
            type="button"
            onClick={onLogout}
            className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-100"
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        {current ? (
          <CollectionView key={current.name} collection={current} />
        ) : (
          <p className="p-8 text-slate-500">No collections registered.</p>
        )}
      </main>
    </div>
  );
}
