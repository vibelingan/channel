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
  catalogLocalSeed: isEnabled(process.env.E2E_CATALOG_LOCAL_SEED),
  catalogLocalDb: process.env.E2E_CATALOG_LOCAL_DB?.trim() ?? '',
  mediaUploadSmoke: isEnabled(process.env.E2E_MEDIA_UPLOAD_SMOKE),
  oemUploadSmoke: isEnabled(process.env.E2E_OEM_UPLOAD_SMOKE),
  runId: process.env.E2E_RUN_ID?.trim() || uniqueRunId(),
} as const;

export function hasAdminCredentials(): boolean {
  return e2e.adminEmail.length > 0 && e2e.adminPassword.length > 0;
}

export function requireAdminCredentialsWhenEnabled(enabled: boolean, suite: string): void {
  if (enabled && !hasAdminCredentials()) {
    throw new Error(`${suite} requires E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD.`);
  }
}

export function requireCatalogLocalSeedWhenEnabled(enabled: boolean): void {
  if (enabled && !e2e.catalogLocalSeed) {
    throw new Error('Catalog mutations require E2E_CATALOG_LOCAL_SEED=1 on a disposable local DB.');
  }
  if (!enabled) return;
  if (!e2e.catalogLocalDb) {
    throw new Error('Catalog mutations require E2E_CATALOG_LOCAL_DB from the disposable runner.');
  }
  for (const [label, value] of [
    ['E2E_SITE_URL', e2e.siteUrl],
    ['E2E_API_URL', e2e.apiUrl],
  ] as const) {
    const hostname = new URL(value).hostname;
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
      throw new Error(`${label} must be loopback for catalog mutations.`);
    }
  }
}
