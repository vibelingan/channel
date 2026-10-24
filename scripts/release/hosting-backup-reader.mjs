import { captureBoundHostingBackup } from '../capture-hosting-backup.mjs';
import { fetchFully } from '../smoke-http.mjs';
import { identity } from './input.mjs';

export function captureManagerHostingBackup({ provider, target, output, request = fetchFully }) {
  if (identity(provider.target) !== identity(target))
    throw new Error('Backup manager target differs.');
  return captureBoundHostingBackup({
    target,
    output,
    request,
    reader: {
      inventory: async () => ({
        ...target,
        observedAt: new Date().toISOString(),
        entries: (await provider.readInventory()).filter(
          (entry) => !entry.path.startsWith('.cloudbase-backup/'),
        ),
      }),
      configuration: () => provider.readConfiguration(),
    },
  });
}
