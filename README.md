# Tattoo Studio OS

Booking link with deposit collection, digital consent forms, and automated aftercare reminders.
Stop running your studio out of Instagram DMs.

## Stack

- **Hono** for HTTP, server-rendered HTML
- **Cloudflare Workers + D1** for compute and data storage
- **Stripe Checkout** for deposits (demo mode if no key set)
- **Cron Trigger** for aftercare reminders (runs every minute via `wrangler.toml`)
- **Vitest** for tests

## Quick start

```bash
npm install

# Create D1 database (once)
wrangler d1 create tattoo-studio
# Paste the returned database_id into wrangler.toml

# Apply migrations
wrangler d1 migrations apply tattoo-studio --local

# Run locally
wrangler dev
```

Open <http://localhost:8787>, sign up, copy your booking link.

## Features

- Per-artist public booking page (`/book/<slug>`)
- Booking → deposit checkout → consent form → appointment → aftercare flow
- Stripe deposits in `payment` mode (demo mode auto-confirms when no Stripe key set)
- Digital consent form with typed signature
- Automated 3-day and 14-day aftercare reminders via Cron Trigger (every minute sweep)
- Plug in any notification provider via `setAftercareDelivery()` (Resend, Postmark, Twilio, etc.)
- Settings: studio name, default deposit, booking slug

## Booking flow

1. Client visits `/book/<slug>` → fills out idea + preferred date
2. Redirected to Stripe Checkout for deposit (or auto-paid in demo mode)
3. After deposit, redirected to consent form → types name to sign
4. Artist sees booking in `/dashboard`, schedules appointment date
5. Artist marks "completed" after the session
6. Cron Trigger fires every minute, sends 3-day reminder, then 14-day reminder

## Project layout

```
src/
  index.ts      # Hono app, all routes + cron handler
  db.ts         # D1 queries
  auth.ts       # session auth
  billing.ts    # Stripe deposit checkout
  aftercare.ts  # scheduled aftercare sweep + injection point for delivery
  views.ts      # safe HTML helper
migrations/
  0001_init.sql
tests/
  auth.test.ts
  aftercare.test.ts  # exercises full sweep logic with isolated D1
wrangler.toml
```

## Wiring real notifications

Replace the default delivery in your bootstrap code:

```ts
import { setAftercareDelivery } from './aftercare.ts';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY!);
setAftercareDelivery(async (msg) => {
  await resend.emails.send({
    from: 'studio@your-domain.com',
    to: msg.clientEmail,
    subject: msg.stage === 'day3' ? 'Aftercare check-in: day 3' : 'How is your tattoo healing?',
    text: `Hey ${msg.clientName}, ...`,
  });
});
```

## Tests

```bash
npm test
```

The aftercare tests use an isolated D1 database per test run, exercise the full sweep logic, and verify idempotency.

## Deploy

```bash
wrangler d1 create tattoo-studio
wrangler d1 migrations apply tattoo-studio
wrangler deploy
```

For production, set via `wrangler secret put`:
- `SESSION_SECRET`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`

And set in `wrangler.toml` `[vars]`:
- `APP_URL=https://your-worker.workers.dev`
- `DEFAULT_DEPOSIT_CENTS=5000`
