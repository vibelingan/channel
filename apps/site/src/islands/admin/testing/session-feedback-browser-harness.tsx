import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountMenu } from '../../auth/AccountMenu.tsx';
import { AuthForm } from '../../auth/AuthForm.tsx';
import { AdminApp } from '../AdminApp.tsx';
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
