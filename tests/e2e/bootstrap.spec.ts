import { expect, test } from '@playwright/test';
import { adminAction, loginAdmin } from './helpers/admin-api';
import { e2e, hasAdminCredentials } from './helpers/env';

test.describe('one-shot admin bootstrap', () => {
  // Skip ONLY when the opt-in flag is off. When it IS on, a missing bootstrap token
  // or admin creds must FAIL (below), never silently skip — same fail-fast rule as
  // media-upload.spec.ts.
  test.skip(!e2e.enableBootstrap, 'Set E2E_ENABLE_BOOTSTRAP=1 to run bootstrap.');

  test('creates the first admin and proves the credential can log in', async ({ request }) => {
    if (e2e.bootstrapToken.length === 0 || !hasAdminCredentials()) {
      throw new Error(
        'E2E_ENABLE_BOOTSTRAP=1 requires E2E_BOOTSTRAP_ADMIN_TOKEN, E2E_ADMIN_EMAIL, and E2E_ADMIN_PASSWORD.',
      );
    }

    const result = await adminAction<{
      user: { email: string; role: string };
      bootstrap: { disableRequired: boolean };
    }>(request, 'bootstrapAdmin', { token: e2e.bootstrapToken });

    expect(result.user.email).toBe(e2e.adminEmail);
    expect(result.user.role).toBe('admin');
    expect(result.bootstrap.disableRequired).toBe(true);

    const session = await loginAdmin(request);
    expect(session.user.email).toBe(e2e.adminEmail);
    expect(session.user.role).toBe('admin');
  });
});
