/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `1` when the frontend runs against the in-browser mock backend. */
  readonly VITE_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
