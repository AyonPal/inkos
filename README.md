# Tattoo Studio OS

Booking link with deposit collection, digital consent forms, and automated aftercare reminders.
Stop running your studio out of Instagram DMs.

## Stack

- **Hono** for HTTP, server-rendered HTML
- **Prisma + SQLite** (swap to Postgres later by editing `prisma/schema.prisma`)
- **Stripe Checkout** for deposits (demo mode if no key set)
- **Built-in scheduler** for aftercare reminders (every 60s sweep)
- **Vitest** for tests

## Quick start

```bash
npm install
cp .env.example .env
npx prisma migrate dev --name init
npm run dev
```

Open <http://localhost:3002>, sign up, copy your booking link.

## Features

- Per-artist public booking page (`/book/<slug>`)
- Booking → deposit checkout → consent form → appointment → aftercare flow
- Stripe deposits in `payment` mode (demo mode auto-confirms when no Stripe key set)
- Digital consent form with typed signature
- Automated 3-day and 14-day aftercare reminders (sweeps every minute)
- Plug in any notification provider via `setAftercareDelivery()` (Resend, Postmark, Twilio, etc.)
- Settings: studio name, default deposit, booking slug

## Booking flow

1. Client visits `/book/<slug>` → fills out idea + preferred date
2. Redirected to Stripe Checkout for deposit (or auto-paid in demo mode)
3. After deposit, redirected to consent form → types name to sign
4. Artist sees booking in `/dashboard`, schedules appointment date
5. Artist marks "completed" after the session
6. Aftercare sweep runs every 60s, sends 3-day reminder, then 14-day reminder

## Project layout

```
src/
  server.ts      # Hono app, all routes
  db.ts          # Prisma client
  auth.ts        # session auth
  billing.ts     # Stripe deposit checkout
  aftercare.ts   # scheduled aftercare sweep + injection point for delivery
  views.ts       # safe HTML helper
prisma/
  schema.prisma
tests/
  auth.test.ts
  aftercare.test.ts  # spawns isolated sqlite, exercises full sweep logic
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

The aftercare tests spawn an isolated SQLite database per test run, exercise the full sweep logic, and verify idempotency.

## Production

```bash
docker build -t tattoo-studio-os .
docker run -p 3002:3002 --env-file .env tattoo-studio-os
```
