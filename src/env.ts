/** Cloudflare Worker environment bindings. */
export interface Env {
  DB: D1Database;
  APP_URL: string;
  SESSION_SECRET: string;
  DEFAULT_DEPOSIT_CENTS: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
}
