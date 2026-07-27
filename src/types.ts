export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY: string;
  SESSION_SECRET: string;
  // Acumatica (FR-6.1 PO matching) — not yet provisioned, see README.md
  // "Acumatica setup". Calls in src/acumatica.ts fail clearly until these
  // are set, rather than being silently skipped.
  ACUMATICA_BASE_URL: string;
  ACUMATICA_ENDPOINT_VERSION: string;
  ACUMATICA_CLIENT_ID: string;
  ACUMATICA_CLIENT_SECRET: string;
};

export type Variables = {
  userId: number;
};
