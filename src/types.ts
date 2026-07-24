export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY: string;
  SESSION_SECRET: string;
};

export type Variables = {
  userId: number;
};
