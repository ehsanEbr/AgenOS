/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the API. Defaults to same-origin `/api/v1` (proxied by Vite in development). */
  readonly VITE_API_BASE_URL?: string;
  /** `disabled` (Phase 1 default) skips authentication; real auth arrives with the Identity phase. */
  readonly VITE_AUTH_MODE?: 'disabled' | 'required';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
