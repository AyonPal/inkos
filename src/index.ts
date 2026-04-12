/**
 * Tattoo Studio OS — Cloudflare Worker entry point.
 *
 * Hono app handles all routes. Cron triggers handle aftercare sweeps
 * and session cleanup. Export { fetch, scheduled }.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { csrf } from 'hono/csrf';
import { getCookie } from 'hono/cookie';
import type { Env } from './env.ts';
import {
  authMiddleware,
  requireAuth,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  type AppEnv,
  type UserRow,
} from './auth.ts';
import { hashPassword, verifyPassword, randomHex } from './crypto.ts';
import { createDepositCheckout, isStripeEnabled, verifyWebhookEvent } from './billing.ts';
import { layout, html, esc, raw } from './views.ts';
import { runAftercareSweep } from './aftercare.ts';

const app = new Hono<AppEnv>();

// CSRF protection — exempt webhook
app.use('*', async (c, next) => {
  if (c.req.path === '/webhooks/stripe') return next();
  return csrf()(c, next);
});

// Auth middleware (loads user from session cookie)
app.use('*', authMiddleware);

// ---------- public ----------

app.get('/', (c) => {
  const user = c.get('user');
  return c.html(
    layout({
      title: 'Run your studio, not your DMs',
      user: user ? { email: user.email, studioName: user.studio_name } : null,
      body: html`
        <h1>Run your studio, not your DMs</h1>
        <p class="muted">Booking link with deposit collection, digital consent forms, and automated aftercare reminders. Built for tattoo artists.</p>
        ${user
          ? raw(html`<a class="btn" href="/dashboard">Open dashboard →</a>`)
          : raw(html`<a class="btn" href="/signup">Start free</a> <a class="btn secondary" href="/login">Login</a>`)}
      `,
    }),
  );
});

// ---------- auth ----------

const credSchema = z.object({ email: z.string().email(), password: z.string().min(8) });

function authForm(title: string, action: string, error?: string): string {
  return html`
    <h1>${title}</h1>
    ${error ? raw(`<p class="error">${esc(error)}</p>`) : ''}
    <form method="post" action="${action}" class="card stack">
      <label>Email<input name="email" type="email" required></label>
      <label>Password<input name="password" type="password" required minlength="8"></label>
      <button type="submit">${title}</button>
    </form>
  `;
}

app.get('/signup', (c) =>
  c.html(layout({ title: 'Sign up', user: null, body: authForm('Sign up', '/signup') })),
);

app.post('/signup', async (c) => {
  const form = await c.req.formData();
  const parsed = credSchema.safeParse({ email: form.get('email'), password: form.get('password') });
  if (!parsed.success)
    return c.html(
      layout({ title: 'Sign up', user: null, body: authForm('Sign up', '/signup', 'Invalid email or password too short.') }),
    );

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(parsed.data.email)
    .first();
  if (existing)
    return c.html(
      layout({ title: 'Sign up', user: null, body: authForm('Sign up', '/signup', 'Email already registered.') }),
    );

  const slug = `${parsed.data.email.split('@')[0].replace(/[^a-z0-9]+/gi, '').toLowerCase()}-${randomHex(2)}`;
  const defaultDeposit = Number(c.env.DEFAULT_DEPOSIT_CENTS ?? '5000');
  const pwHash = await hashPassword(parsed.data.password);

  const result = await c.env.DB.prepare(
    'INSERT INTO users (email, password_hash, booking_slug, deposit_cents) VALUES (?, ?, ?, ?)',
  )
    .bind(parsed.data.email, pwHash, slug, defaultDeposit)
    .run();

  const userId = result.meta.last_row_id as number;
  const sid = await createSession(c.env.DB, userId);
  setSessionCookie(c, sid);
  return c.redirect('/dashboard');
});

app.get('/login', (c) =>
  c.html(layout({ title: 'Login', user: null, body: authForm('Login', '/login') })),
);

app.post('/login', async (c) => {
  const form = await c.req.formData();
  const parsed = credSchema.safeParse({ email: form.get('email'), password: form.get('password') });
  if (!parsed.success)
    return c.html(layout({ title: 'Login', user: null, body: authForm('Login', '/login', 'Invalid input.') }));

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?')
    .bind(parsed.data.email)
    .first<UserRow>();
  if (!user || !(await verifyPassword(parsed.data.password, user.password_hash)))
    return c.html(layout({ title: 'Login', user: null, body: authForm('Login', '/login', 'Wrong email or password.') }));

  const sid = await createSession(c.env.DB, user.id);
  setSessionCookie(c, sid);
  return c.redirect('/dashboard');
});

app.get('/logout', async (c) => {
  const sid = getCookie(c, 'tatos_session');
  if (sid) await destroySession(c.env.DB, sid);
  clearSessionCookie(c);
  return c.redirect('/');
});

// ---------- dashboard ----------

app.use('/dashboard*', requireAuth);
app.use('/bookings/*', requireAuth);
app.use('/settings*', requireAuth);

type BookingRow = {
  id: number;
  user_id: number;
  client_name: string;
  client_email: string;
  client_phone: string | null;
  description: string;
  preferred_date: string;
  duration_minutes: number;
  status: string;
  deposit_cents: number;
  deposit_paid_at: string | null;
  consent_signed_at: string | null;
  consent_name: string | null;
  appointment_date: string | null;
  aftercare_day3_at: string | null;
  aftercare_day14_at: string | null;
  client_ip: string | null;
  notes: string | null;
  created_at: string;
};

function userView(u: UserRow) {
  return { email: u.email, studioName: u.studio_name };
}

app.get('/dashboard', async (c) => {
  const user = c.get('user')!;
  const bookings = await c.env.DB.prepare(
    'SELECT * FROM bookings WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
  )
    .bind(user.id)
    .all<BookingRow>();

  const list = bookings.results
    .map(
      (b) => html`
        <div class="card">
          <div class="row" style="justify-content:space-between">
            <div>
              <strong>${b.client_name}</strong> <span class="pill ${b.status}">${b.status.replace('_', ' ')}</span>
              <div class="muted">${b.description}</div>
              <div class="muted">Preferred: ${b.preferred_date.slice(0, 10)} · Deposit: $${(b.deposit_cents / 100).toFixed(2)}</div>
            </div>
            <a class="btn secondary" href="/bookings/${String(b.id)}">Open →</a>
          </div>
        </div>
      `,
    )
    .join('');

  const bookingUrl = `${c.env.APP_URL}/book/${user.booking_slug}`;

  return c.html(
    layout({
      title: 'Dashboard',
      user: userView(user),
      body: html`
        <h1>${user.studio_name}</h1>
        <div class="card stack">
          <div>Public booking link:</div>
          <div><a href="${bookingUrl}" target="_blank">${bookingUrl}</a></div>
          <div class="muted">Default deposit: $${(user.deposit_cents / 100).toFixed(2)}. Change in <a href="/settings">settings</a>.</div>
        </div>
        <h2>Recent bookings</h2>
        ${bookings.results.length === 0
          ? raw('<p class="muted">No bookings yet. Share your booking link.</p>')
          : raw(list)}
      `,
    }),
  );
});

app.get('/settings', async (c) => {
  const user = c.get('user')!;
  return c.html(
    layout({
      title: 'Settings',
      user: userView(user),
      body: html`
        <h1>Studio settings</h1>
        <form method="post" action="/settings" class="card stack">
          <label>Studio name<input name="studioName" value="${user.studio_name}" required></label>
          <label>Default deposit (USD)<input name="depositDollars" type="number" min="0" step="1" value="${(user.deposit_cents / 100).toFixed(0)}" required></label>
          <label>Booking slug (used in your public URL)<input name="bookingSlug" value="${user.booking_slug}" required pattern="[a-z0-9-]+"></label>
          <button type="submit">Save</button>
        </form>
      `,
    }),
  );
});

const settingsSchema = z.object({
  studioName: z.string().min(1).max(80),
  depositDollars: z.coerce.number().int().min(0).max(10000),
  bookingSlug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .min(2)
    .max(40),
});

app.post('/settings', async (c) => {
  const user = c.get('user')!;
  const form = await c.req.formData();
  const parsed = settingsSchema.safeParse({
    studioName: form.get('studioName'),
    depositDollars: form.get('depositDollars'),
    bookingSlug: form.get('bookingSlug'),
  });
  if (!parsed.success) return c.text('Invalid input', 400);
  if (parsed.data.bookingSlug !== user.booking_slug) {
    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE booking_slug = ?')
      .bind(parsed.data.bookingSlug)
      .first();
    if (existing) return c.text('That booking slug is taken', 400);
  }
  await c.env.DB.prepare(
    'UPDATE users SET studio_name = ?, deposit_cents = ?, booking_slug = ? WHERE id = ?',
  )
    .bind(parsed.data.studioName, parsed.data.depositDollars * 100, parsed.data.bookingSlug, user.id)
    .run();
  return c.redirect('/dashboard');
});

// ---------- public booking page ----------

app.get('/book/:slug', async (c) => {
  const artist = await c.env.DB.prepare('SELECT * FROM users WHERE booking_slug = ?')
    .bind(c.req.param('slug'))
    .first<UserRow>();
  if (!artist) return c.notFound();
  return c.html(
    layout({
      title: `Book a session at ${artist.studio_name}`,
      user: null,
      body: html`
        <h1>Book at ${artist.studio_name}</h1>
        <p class="muted">Submit your idea below. A $${(artist.deposit_cents / 100).toFixed(0)} deposit is required to confirm. The deposit goes toward your final price.</p>
        <form method="post" action="/book/${artist.booking_slug}" class="card stack">
          <label>Your name<input name="clientName" required></label>
          <label>Your email<input name="clientEmail" type="email" required></label>
          <label>Your phone (optional)<input name="clientPhone" type="tel"></label>
          <label>Tattoo idea<textarea name="description" required minlength="10" placeholder="Describe size, placement, style, references..."></textarea></label>
          <label>Preferred date<input name="preferredDate" type="date" required></label>
          <label>Estimated session length (minutes)<input name="durationMinutes" type="number" min="30" max="600" step="15" value="120" required></label>
          <p class="muted" style="font-size:12px">By booking, you agree that this deposit is non-refundable within 48 hours of your appointment. Cancellations with 48+ hours notice receive a full refund.</p>
          <button type="submit">Continue to deposit →</button>
        </form>
      `,
    }),
  );
});

const bookingSchema = z.object({
  clientName: z.string().min(1).max(80),
  clientEmail: z.string().email(),
  clientPhone: z.string().max(40).optional().nullable(),
  description: z.string().min(10).max(2000),
  preferredDate: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'invalid date'),
  durationMinutes: z.coerce.number().int().min(30).max(600),
});

app.post('/book/:slug', async (c) => {
  const artist = await c.env.DB.prepare('SELECT * FROM users WHERE booking_slug = ?')
    .bind(c.req.param('slug'))
    .first<UserRow>();
  if (!artist) return c.notFound();
  const form = await c.req.formData();
  const parsed = bookingSchema.safeParse({
    clientName: form.get('clientName'),
    clientEmail: form.get('clientEmail'),
    clientPhone: form.get('clientPhone') || null,
    description: form.get('description'),
    preferredDate: form.get('preferredDate'),
    durationMinutes: form.get('durationMinutes'),
  });
  if (!parsed.success) return c.text('Invalid input: ' + parsed.error.message, 400);

  const clientIp = c.req.header('x-forwarded-for') ?? c.req.header('cf-connecting-ip') ?? 'unknown';

  const result = await c.env.DB.prepare(
    `INSERT INTO bookings (user_id, client_name, client_email, client_phone, description, preferred_date, duration_minutes, deposit_cents, client_ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      artist.id,
      parsed.data.clientName,
      parsed.data.clientEmail,
      parsed.data.clientPhone ?? null,
      parsed.data.description,
      new Date(parsed.data.preferredDate).toISOString(),
      parsed.data.durationMinutes,
      artist.deposit_cents,
      clientIp,
    )
    .run();

  const bookingId = result.meta.last_row_id as number;

  const checkout = await createDepositCheckout(c.env.STRIPE_SECRET_KEY, {
    bookingId,
    customerEmail: parsed.data.clientEmail,
    description: parsed.data.description.slice(0, 80),
    amountCents: artist.deposit_cents,
    successUrl: `${c.env.APP_URL}/book/${artist.booking_slug}/deposit-success`,
    cancelUrl: `${c.env.APP_URL}/book/${artist.booking_slug}`,
  });

  if (checkout.demo) {
    await c.env.DB.prepare(
      "UPDATE bookings SET status = 'deposit_paid', deposit_paid_at = ? WHERE id = ?",
    )
      .bind(new Date().toISOString(), bookingId)
      .run();
  }
  return c.redirect(checkout.url);
});

app.get('/book/:slug/deposit-success', async (c) => {
  const artist = await c.env.DB.prepare('SELECT * FROM users WHERE booking_slug = ?')
    .bind(c.req.param('slug'))
    .first<UserRow>();
  if (!artist) return c.notFound();
  const bookingId = Number(c.req.query('booking') ?? 0);
  return c.html(
    layout({
      title: 'Deposit received',
      user: null,
      body: html`
        <h1>Deposit received ✓</h1>
        <p class="muted">${artist.studio_name} has been notified. You'll get a confirmation when your appointment is scheduled.</p>
        ${bookingId
          ? raw(
              html`<p>Next: <a class="btn" href="/book/${artist.booking_slug}/consent/${String(bookingId)}">Sign your consent form →</a></p>`,
            )
          : ''}
      `,
    }),
  );
});

// ---------- consent form ----------

app.get('/book/:slug/consent/:id', async (c) => {
  const artist = await c.env.DB.prepare('SELECT * FROM users WHERE booking_slug = ?')
    .bind(c.req.param('slug'))
    .first<UserRow>();
  if (!artist) return c.notFound();
  const booking = await c.env.DB.prepare('SELECT * FROM bookings WHERE id = ?')
    .bind(Number(c.req.param('id')))
    .first<BookingRow>();
  if (!booking || booking.user_id !== artist.id) return c.notFound();
  if (booking.consent_signed_at) {
    return c.html(
      layout({
        title: 'Already signed',
        user: null,
        body: html`<h1>Consent already on file ✓</h1><p class="muted">See you on appointment day.</p>`,
      }),
    );
  }
  return c.html(
    layout({
      title: 'Consent form',
      user: null,
      body: html`
        <h1>Consent form</h1>
        <div class="card">
          <p>By signing below, I confirm that:</p>
          <ul>
            <li>I am at least 18 years old and have valid ID.</li>
            <li>I am not under the influence of drugs or alcohol.</li>
            <li>I have disclosed any allergies, medical conditions, or medications.</li>
            <li>I understand tattoos are permanent and aftercare is my responsibility.</li>
            <li>I consent to being tattooed by ${artist.studio_name}.</li>
          </ul>
        </div>
        <form method="post" action="/book/${artist.booking_slug}/consent/${String(booking.id)}" class="card stack">
          <label>Type your full legal name to sign<input name="consentName" required></label>
          <button type="submit">Sign consent</button>
        </form>
      `,
    }),
  );
});

app.post('/book/:slug/consent/:id', async (c) => {
  const artist = await c.env.DB.prepare('SELECT * FROM users WHERE booking_slug = ?')
    .bind(c.req.param('slug'))
    .first<UserRow>();
  if (!artist) return c.notFound();
  const booking = await c.env.DB.prepare('SELECT * FROM bookings WHERE id = ?')
    .bind(Number(c.req.param('id')))
    .first<BookingRow>();
  if (!booking || booking.user_id !== artist.id) return c.notFound();
  const form = await c.req.formData();
  const consentName = String(form.get('consentName') ?? '').trim();
  if (consentName.length < 2) return c.text('Please type your full name', 400);
  const consentIp = c.req.header('x-forwarded-for') ?? c.req.header('cf-connecting-ip') ?? 'unknown';
  const notes = [booking.notes, `consent-ip: ${consentIp}`].filter(Boolean).join('\n');
  await c.env.DB.prepare(
    "UPDATE bookings SET status = 'consented', consent_signed_at = ?, consent_name = ?, notes = ? WHERE id = ?",
  )
    .bind(new Date().toISOString(), consentName, notes, booking.id)
    .run();
  return c.html(
    layout({
      title: 'Signed',
      user: null,
      body: html`<h1>Thanks, ${consentName} ✓</h1><p class="muted">Consent recorded. See you on appointment day.</p>`,
    }),
  );
});

// ---------- artist booking detail ----------

app.get('/bookings/:id', async (c) => {
  const user = c.get('user')!;
  const booking = await c.env.DB.prepare('SELECT * FROM bookings WHERE id = ?')
    .bind(Number(c.req.param('id')))
    .first<BookingRow>();
  if (!booking || booking.user_id !== user.id) return c.notFound();
  return c.html(
    layout({
      title: `Booking · ${booking.client_name}`,
      user: userView(user),
      body: html`
        <p class="muted"><a href="/dashboard">← Dashboard</a></p>
        <h1>${booking.client_name} <span class="pill ${booking.status}">${booking.status.replace('_', ' ')}</span></h1>
        <div class="card stack">
          <div><strong>Email:</strong> ${booking.client_email}</div>
          ${booking.client_phone ? raw(html`<div><strong>Phone:</strong> ${booking.client_phone}</div>`) : ''}
          <div><strong>Idea:</strong></div>
          <div class="muted">${booking.description}</div>
          <div><strong>Preferred date:</strong> ${booking.preferred_date.slice(0, 10)}</div>
          <div><strong>Duration:</strong> ${String(booking.duration_minutes)} min</div>
          <div><strong>Deposit:</strong> $${(booking.deposit_cents / 100).toFixed(2)} ${booking.deposit_paid_at ? raw('<span class="ok">paid</span>') : raw('<span class="error">unpaid</span>')}</div>
          ${booking.consent_signed_at
            ? raw(html`<div><strong>Consent:</strong> ✓ signed by ${booking.consent_name ?? ''} on ${booking.consent_signed_at.slice(0, 10)}</div>`)
            : raw('<div class="muted">Consent: not yet signed</div>')}
          ${booking.appointment_date
            ? raw(html`<div><strong>Appointment:</strong> ${booking.appointment_date.slice(0, 16).replace('T', ' ')}</div>`)
            : ''}
        </div>
        <div class="card stack">
          <h2 style="margin-top:0">Schedule appointment</h2>
          <form method="post" action="/bookings/${String(booking.id)}/schedule" class="stack">
            <label>Appointment date & time<input type="datetime-local" name="appointmentDate" value="${booking.appointment_date ? booking.appointment_date.slice(0, 16) : ''}" required></label>
            <button type="submit">Save</button>
          </form>
        </div>
        <div class="card stack">
          <h2 style="margin-top:0">Mark as completed</h2>
          <p class="muted">Triggers automated 3-day and 14-day aftercare reminders to ${booking.client_email}.</p>
          <form method="post" action="/bookings/${String(booking.id)}/complete">
            <button>Mark completed</button>
          </form>
        </div>
        <div class="card stack">
          <h2 style="margin-top:0">Aftercare status</h2>
          <div>Day 3: ${booking.aftercare_day3_at ? raw('<span class="ok">sent ' + booking.aftercare_day3_at.slice(0, 10) + '</span>') : '<span class="muted">pending</span>'}</div>
          <div>Day 14: ${booking.aftercare_day14_at ? raw('<span class="ok">sent ' + booking.aftercare_day14_at.slice(0, 10) + '</span>') : '<span class="muted">pending</span>'}</div>
        </div>
      `,
    }),
  );
});

const scheduleSchema = z.object({
  appointmentDate: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'invalid date'),
});

app.post('/bookings/:id/schedule', async (c) => {
  const user = c.get('user')!;
  const booking = await c.env.DB.prepare('SELECT * FROM bookings WHERE id = ?')
    .bind(Number(c.req.param('id')))
    .first<BookingRow>();
  if (!booking || booking.user_id !== user.id) return c.notFound();
  const form = await c.req.formData();
  const parsed = scheduleSchema.safeParse({ appointmentDate: form.get('appointmentDate') });
  if (!parsed.success) return c.text('Invalid date', 400);
  await c.env.DB.prepare('UPDATE bookings SET appointment_date = ? WHERE id = ?')
    .bind(new Date(parsed.data.appointmentDate).toISOString(), booking.id)
    .run();
  return c.redirect(`/bookings/${booking.id}`);
});

app.post('/bookings/:id/complete', async (c) => {
  const user = c.get('user')!;
  const booking = await c.env.DB.prepare('SELECT * FROM bookings WHERE id = ?')
    .bind(Number(c.req.param('id')))
    .first<BookingRow>();
  if (!booking || booking.user_id !== user.id) return c.notFound();
  const appointmentDate = booking.appointment_date ?? new Date().toISOString();
  await c.env.DB.prepare("UPDATE bookings SET status = 'completed', appointment_date = ? WHERE id = ?")
    .bind(appointmentDate, booking.id)
    .run();
  return c.redirect(`/bookings/${booking.id}`);
});

app.post('/bookings/:id/cancel', async (c) => {
  const user = c.get('user')!;
  const booking = await c.env.DB.prepare('SELECT * FROM bookings WHERE id = ?')
    .bind(Number(c.req.param('id')))
    .first<BookingRow>();
  if (!booking || booking.user_id !== user.id) return c.notFound();
  await c.env.DB.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").bind(booking.id).run();
  return c.redirect(`/bookings/${booking.id}`);
});

// ---------- stripe webhook ----------

app.post('/webhooks/stripe', async (c) => {
  const body = await c.req.text();
  const sig = c.req.header('stripe-signature') ?? '';
  const event = await verifyWebhookEvent(c.env.STRIPE_SECRET_KEY, c.env.STRIPE_WEBHOOK_SECRET, body, sig);
  if (!event) return c.text('Invalid signature', 400);
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as { metadata?: { booking_id?: string } };
    const bookingId = Number(session.metadata?.booking_id);
    if (bookingId) {
      await c.env.DB.prepare(
        "UPDATE bookings SET status = 'deposit_paid', deposit_paid_at = ? WHERE id = ? AND status = 'pending'",
      )
        .bind(new Date().toISOString(), bookingId)
        .run();
    }
  }
  return c.text('ok');
});

// ---------- Cloudflare Worker export ----------

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // "*/1 * * * *" → aftercare sweep every minute
    // "0 * * * *"   → session cleanup every hour

    if (event.cron === '*/1 * * * *') {
      ctx.waitUntil(runAftercareSweep(env.DB));
    }

    if (event.cron === '0 * * * *') {
      ctx.waitUntil(
        env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run(),
      );
    }
  },
};
