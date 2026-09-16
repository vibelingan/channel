import { resolve } from 'node:path';
import { startSharedUiAcceptance } from './shared-ui-acceptance.ts';

if (process.env.E2E_SHARED_UI_ACCEPTANCE !== '1' || !process.send)
  throw new Error('Test-only service requires explicit opt-in and an owned IPC channel');
const backend = await startSharedUiAcceptance(resolve('apps/local-server/data/shared-ui/ui05'));
let closing = false;
async function dispose() {
  if (closing) return;
  closing = true;
  try {
    await backend.dispose();
    process.exitCode = 0;
  } catch {
    process.exitCode = 1;
  } finally {
    if (process.connected) process.disconnect();
  }
}
process.on('message', (message) => {
  if (message === 'dispose') void dispose();
});
process.once('disconnect', () => {
  void dispose();
});
process.once('SIGTERM', () => {
  void dispose();
});
process.send({ apiUrl: backend.apiUrl, credentials: backend.credentials, file: backend.file });
