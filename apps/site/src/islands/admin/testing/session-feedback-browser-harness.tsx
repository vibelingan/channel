import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setSession } from '../../../lib/session.ts';
import { AccountMenu } from '../../auth/AccountMenu.tsx';
import { AuthForm } from '../../auth/AuthForm.tsx';
import { AdminApp } from '../AdminApp.tsx';
import { AdminApiError, updateRecord } from '../api.ts';
import '../../../styles/global.css';
const container = document.getElementById('session-feedback-root');
if (!container) throw Error('Missing session feedback fixture root');
const view = new URL(location.href).searchParams.get('view');
createRoot(container).render(
  <StrictMode>
    {view === 'login' ? (
      <AuthForm mode="login" />
    ) : view?.startsWith('account') ? (
      <AccountMenu layout={view === 'account-navigation' ? 'navigation' : 'dropdown'} />
    ) : (
      <AdminApp />
    )}
  </StrictMode>,
);
export function replaceTestSession(token: string, id: string) {
  setSession(token, { id, username: 'Operator', email: `${id}@example.test`, role: 'admin' });
}
export async function tryPausedRecordWrite() {
  try {
    await updateRecord('users', 'admin', { username: 'Must not be sent' });
    return 'sent';
  } catch (error) {
    return error instanceof AdminApiError ? error.code : 'unexpected';
  }
}
