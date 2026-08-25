/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_API_BASE_URL?: string;
  readonly PUBLIC_AI_API_BASE_URL?: string;
  readonly PUBLIC_CB_HOST?: string;
  readonly PUBLIC_CB_PROXY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
