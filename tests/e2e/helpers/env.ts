function trimSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function isEnabled(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

function uniqueRunId(): string {
  return `e2e-${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const e2e = {
  siteUrl: trimSlash(process.env.E2E_SITE_URL ?? 'http://localhost:4321'),
  apiUrl: trimSlash(process.env.E2E_API_URL ?? process.env.E2E_SITE_URL ?? 'http://localhost:4321'),
  adminEmail: process.env.E2E_ADMIN_EMAIL?.trim() ?? '',
  adminPassword: process.env.E2E_ADMIN_PASSWORD ?? '',
  bootstrapToken: process.env.E2E_BOOTSTRAP_ADMIN_TOKEN ?? '',
  enableBootstrap: isEnabled(process.env.E2E_ENABLE_BOOTSTRAP),
  allowMutation: isEnabled(process.env.E2E_ALLOW_MUTATION),
  mediaUploadSmoke: isEnabled(process.env.E2E_MEDIA_UPLOAD_SMOKE),
  oemUploadSmoke: isEnabled(process.env.E2E_OEM_UPLOAD_SMOKE),
  runId: process.env.E2E_RUN_ID?.trim() || uniqueRunId(),
} as const;

export function hasAdminCredentials(): boolean {
  return e2e.adminEmail.length > 0 && e2e.adminPassword.length > 0;
}
