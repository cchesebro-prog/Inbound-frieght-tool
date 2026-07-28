export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY: string;
  SESSION_SECRET: string;
  // Acumatica (FR-6.1 PO matching) — see README.md "Acumatica setup". Calls
  // in src/acumatica.ts fail clearly until these are set, rather than being
  // silently skipped. Resource Owner Password Credentials grant (not Client
  // Credentials — not an available option on Wigwam's instance, confirmed
  // 2026-07-28); ACUMATICA_USERNAME/PASSWORD should be a dedicated
  // service-account user, not a personal login.
  ACUMATICA_BASE_URL: string;
  ACUMATICA_CLIENT_ID: string;
  ACUMATICA_CLIENT_SECRET: string;
  ACUMATICA_USERNAME: string;
  ACUMATICA_PASSWORD: string;
  // Not secret — the published contract-based endpoint version, confirmed
  // live against Wigwam's instance ("25.200.001"). Set as a plain [vars]
  // entry in wrangler.toml, not a wrangler secret.
  ACUMATICA_ENDPOINT_VERSION: string;
  // Escape hatch for a stuck batch-operations lock (see src/locks.ts) —
  // required by the x-admin-token header on POST /api/admin/reset-lock.
  ADMIN_RESET_TOKEN: string;
  // Estes Express Cloud API (FR-3.3 live rate quotes, Phase 2) — see
  // src/estes.ts and PHASE1_BUILD_PLAN.md section 8. ESTES_API_KEY was
  // already provisioned via POST /v1/api-key (one-time, outside this app);
  // ESTES_USERNAME/ESTES_PASSWORD Basic-auth a per-session bearer token via
  // POST /authenticate. ESTES_ACCOUNT_NUMBER is sent as payment.account on
  // every rate-quote request.
  ESTES_API_KEY: string;
  ESTES_USERNAME: string;
  ESTES_PASSWORD: string;
  ESTES_ACCOUNT_NUMBER: string;
};

export type Variables = {
  userId: number;
};
