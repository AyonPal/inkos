import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { prisma } from './db.ts';
import {
  authMiddleware,
  requireAuth,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  type AppEnv,
} from './auth.ts';
import { createDepositCheckout, stripeEnabled, verifyWebhookEvent } from './billing.ts';
import { layout, html, esc, raw } from './views.ts';
import { startAftercareScheduler } from './aftercare.ts';
import { getCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  if (c.req.path === '/webhooks/stripe') return next();
  return csrf()(c, next);
});
app.use('*', authMiddleware);

const APP_URL = process.env.APP_URL ?? `http://localhost:${process.env.PORT ?? 3002}`;
const DEFAULT_DEPOSIT = Number(process.env.DEFAULT_DEPOSIT_CENTS ?? 5000);

// ---------- public ----------

app.get('/', (c) => {
  const user = c.get('user');
  return c.html(
    layout({
      title: 'Run your studio, not your DMs',
      user,
      body: html`
        <h1>Run your studio, not your DMs</h1>
        <p class="muted">Booking link with deposit collection, digital consent forms, and automated aftercare reminders. Built for tattoo artists.</p>
        ${user
          ? raw(html`<a class="btn" href="/dashboard">Open dashboard →</a>`)
          : raw(html`<a class="btn" href="/signup">Start free</a> <a class="btn secondary" href="/login">Login</a>`)}
      `,
    })
  );
});

// ---------- auth ----------

const credSchema = z.object({ email: z.string().email(), password: z.string().min(8) });

app.get('/signup', (c) => c.html(layout({ title: 'Sign up', user: null, body: authForm('Sign up', '/signup') })));
app.post('/signup', async (c) => {
  const form = await c.req.formData();
  const parsed = credSchema.safeParse({ email: form.get('email'), password: form.get('password') });
  if (!parsed.success) return c.html(layout({ title: 'Sign up', user: null, body: authForm('Sign up', '/signup', 'Invalid email or password too short.') }));
  const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (existing) return c.html(layout({ title: 'Sign up', user: null, body: authForm('Sign up', '/signup', 'Email already registered.') }));
  const bookingSlug = `${parsed.data.email.split('@')[0].replace(/[^a-z0-9]+/gi, '').toLowerCase()}-${randomBytes(2).toString('hex')}`;
  const user = await prisma.user.create({
    data: {
      email: parsed.data.email,
      passwordHash: hashPassword(parsed.data.password),
      bookingSlug,
      depositCents: DEFAULT_DEPOSIT,
    },
  });
  const sid = await createSession(user.id);
  setSessionCookie(c, sid);
  return c.redirect('/dashboard');
});

app.get('/login', (c) => c.html(layout({ title: 'Login', user: null, body: authForm('Login', '/login') })));
app.post('/login', async (c) => {
  const form = await c.req.formData();
  const parsed = credSchema.safeParse({ email: form.get('email'), password: form.get('password') });
  if (!parsed.success) return c.html(layout({ title: 'Login', user: null, body: authForm('Login', '/login', 'Invalid input.') }));
  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (!user || !verifyPassword(parsed.data.password, user.passwordHash))
    return c.html(layout({ title: 'Login', user: null, body: authForm('Login', '/login', 'Wrong email or password.') }));
  const sid = await createSession(user.id);
  setSessionCookie(c, sid);
  return c.redirect('/dashboard');
});

app.get('/logout', async (c) => {
  const sid = getCookie(c, 'tatos_session');
  if (sid) await destroySession(sid);
  clearSessionCookie(c);
  return c.redirect('/');
});

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

// ---------- dashboard ----------

app.use('/dashboard*', requireAuth);
app.use('/bookings/*', requireAuth);
app.use('/settings*', requireAuth);

app.get('/dashboard', async (c) => {
  const user = c.get('user')!;
  const bookings = await prisma.booking.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  const list = bookings
    .map(
      (b) => html`
        <div class="card">
          <div class="row" style="justify-content:space-between">
            <div>
              <strong>${b.clientName}</strong> <span class="pill ${b.status}">${b.status.replace('_', ' ')}</span>
              <div class="muted">${b.description}</div>
              <div class="muted">Preferred: ${b.preferredDate.toISOString().slice(0, 10)} · Deposit: $${(b.depositCents / 100).toFixed(2)}</div>
            </div>
            <a class="btn secondary" href="/bookings/${b.id}">Open →</a>
          </div>
        </div>
      `
    )
    .join('');

  const bookingUrl = `${APP_URL}/book/${user.bookingSlug}`;

  return c.html(
    layout({
      title: 'Dashboard',
      user,
      body: html`
        <h1>${user.studioName}</h1>
        <div class="card stack">
          <div>Public booking link:</div>
          <div><a href="${bookingUrl}" target="_blank">${bookingUrl}</a></div>
          <div class="muted">Default deposit: $${(user.depositCents / 100).toFixed(2)}. Change in <a href="/settings">settings</a>.</div>
        </div>
        <h2>Recent bookings</h2>
        ${bookings.length === 0 ? raw('<p class="muted">No bookings yet. Share your booking link.</p>') : raw(list)}
      `,
    })
  );
});

app.get('/settings', async (c) => {
  const user = c.get('user')!;
  return c.html(
    layout({
      title: 'Settings',
      user,
      body: html`
        <h1>Studio settings</h1>
        <form method="post" action="/settings" class="card stack">
          <label>Studio name<input name="studioName" value="${user.studioName}" required></label>
          <label>Default deposit (USD)<input name="depositDollars" type="number" min="0" step="1" value="${(user.depositCents / 100).toFixed(0)}" required></label>
          <label>Booking slug (used in your public URL)<input name="bookingSlug" value="${user.bookingSlug}" required pattern="[a-z0-9-]+"></label>
          <button type="submit">Save</button>
        </form>
      `,
    })
  );
});

const settingsSchema = z.object({
  studioName: z.string().min(1).max(80),
  depositDollars: z.coerce.number().int().min(0).max(10000),
  bookingSlug: z.string().regex(/^[a-z0-9-]+$/).min(2).max(40),
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
  // Slug uniqueness check
  if (parsed.data.bookingSlug !== user.bookingSlug) {
    const existing = await prisma.user.findUnique({ where: { bookingSlug: parsed.data.bookingSlug } });
    if (existing) return c.text('That booking slug is taken', 400);
  }
  await prisma.user.update({
    where: { id: user.id },
    data: {
      studioName: parsed.data.studioName,
      depositCents: parsed.data.depositDollars * 100,
      bookingSlug: parsed.data.bookingSlug,
    },
  });
  return c.redirect('/dashboard');
});

// ---------- public booking page ----------

app.get('/book/:slug', async (c) => {
  const artist = await prisma.user.findUnique({ where: { bookingSlug: c.req.param('slug') } });
  if (!artist) return c.notFound();
  return c.html(
    layout({
      title: `Book a session at ${artist.studioName}`,
      user: null,
      body: html`
        <h1>Book at ${artist.studioName}</h1>
        <p class="muted">Submit your idea below. A $${(artist.depositCents / 100).toFixed(0)} deposit is required to confirm. The deposit goes toward your final price.</p>
        <form method="post" action="/book/${artist.bookingSlug}" class="card stack">
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
    })
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
  const artist = await prisma.user.findUnique({ where: { bookingSlug: c.req.param('slug') } });
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

  const booking = await prisma.booking.create({
    data: {
      userId: artist.id,
      clientName: parsed.data.clientName,
      clientEmail: parsed.data.clientEmail,
      clientPhone: parsed.data.clientPhone ?? null,
      description: parsed.data.description,
      preferredDate: new Date(parsed.data.preferredDate),
      durationMinutes: parsed.data.durationMinutes,
      depositCents: artist.depositCents,
      clientIp,
    },
  });

  const checkout = await createDepositCheckout({
    bookingId: booking.id,
    customerEmail: parsed.data.clientEmail,
    description: parsed.data.description.slice(0, 80),
    amountCents: artist.depositCents,
    successUrl: `${APP_URL}/book/${artist.bookingSlug}/deposit-success`,
    cancelUrl: `${APP_URL}/book/${artist.bookingSlug}`,
  });

  if (checkout.demo) {
    // Auto-mark deposit paid for testability
    await prisma.booking.update({
      where: { id: booking.id },
      data: { status: 'deposit_paid', depositPaidAt: new Date() },
    });
  }
  return c.redirect(checkout.url);
});

app.get('/book/:slug/deposit-success', async (c) => {
  const artist = await prisma.user.findUnique({ where: { bookingSlug: c.req.param('slug') } });
  if (!artist) return c.notFound();
  const bookingId = Number(c.req.query('booking') ?? 0);
  const booking = bookingId ? await prisma.booking.findUnique({ where: { id: bookingId } }) : null;
  return c.html(
    layout({
      title: 'Deposit received',
      user: null,
      body: html`
        <h1>Deposit received ✓</h1>
        <p class="muted">${artist.studioName} has been notified. You'll get a confirmation when your appointment is scheduled.</p>
        ${booking ? raw(html`<p>Next: <a class="btn" href="/book/${artist.bookingSlug}/consent/${booking.id}">Sign your consent form →</a></p>`) : ''}
      `,
    })
  );
});

// ---------- consent form ----------

app.get('/book/:slug/consent/:id', async (c) => {
  const artist = await prisma.user.findUnique({ where: { bookingSlug: c.req.param('slug') } });
  if (!artist) return c.notFound();
  const booking = await prisma.booking.findUnique({ where: { id: Number(c.req.param('id')) } });
  if (!booking || booking.userId !== artist.id) return c.notFound();
  if (booking.consentSignedAt) {
    return c.html(layout({ title: 'Already signed', user: null, body: html`<h1>Consent already on file ✓</h1><p class="muted">See you on appointment day.</p>` }));
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
            <li>I consent to being tattooed by ${artist.studioName}.</li>
          </ul>
        </div>
        <form method="post" action="/book/${artist.bookingSlug}/consent/${booking.id}" class="card stack">
          <label>Type your full legal name to sign<input name="consentName" required></label>
          <button type="submit">Sign consent</button>
        </form>
      `,
    })
  );
});

app.post('/book/:slug/consent/:id', async (c) => {
  const artist = await prisma.user.findUnique({ where: { bookingSlug: c.req.param('slug') } });
  if (!artist) return c.notFound();
  const booking = await prisma.booking.findUnique({ where: { id: Number(c.req.param('id')) } });
  if (!booking || booking.userId !== artist.id) return c.notFound();
  const form = await c.req.formData();
  const consentName = String(form.get('consentName') ?? '').trim();
  if (consentName.length < 2) return c.text('Please type your full name', 400);
  const consentIp = c.req.header('x-forwarded-for') ?? c.req.header('cf-connecting-ip') ?? 'unknown';
  await prisma.booking.update({
    where: { id: booking.id },
    data: {
      status: 'consented',
      consentSignedAt: new Date(),
      consentName,
      notes: [booking.notes, `consent-ip: ${consentIp}`].filter(Boolean).join('\n'),
    },
  });
  return c.html(layout({ title: 'Signed', user: null, body: html`<h1>Thanks, ${consentName} ✓</h1><p class="muted">Consent recorded. See you on appointment day.</p>` }));
});

// ---------- artist booking detail ----------

app.get('/bookings/:id', async (c) => {
  const user = c.get('user')!;
  const booking = await prisma.booking.findUnique({ where: { id: Number(c.req.param('id')) } });
  if (!booking || booking.userId !== user.id) return c.notFound();
  return c.html(
    layout({
      title: `Booking · ${booking.clientName}`,
      user,
      body: html`
        <p class="muted"><a href="/dashboard">← Dashboard</a></p>
        <h1>${booking.clientName} <span class="pill ${booking.status}">${booking.status.replace('_', ' ')}</span></h1>
        <div class="card stack">
          <div><strong>Email:</strong> ${booking.clientEmail}</div>
          ${booking.clientPhone ? raw(html`<div><strong>Phone:</strong> ${booking.clientPhone}</div>`) : ''}
          <div><strong>Idea:</strong></div>
          <div class="muted">${booking.description}</div>
          <div><strong>Preferred date:</strong> ${booking.preferredDate.toISOString().slice(0, 10)}</div>
          <div><strong>Duration:</strong> ${booking.durationMinutes} min</div>
          <div><strong>Deposit:</strong> $${(booking.depositCents / 100).toFixed(2)} ${booking.depositPaidAt ? raw('<span class="ok">paid</span>') : raw('<span class="error">unpaid</span>')}</div>
          ${booking.consentSignedAt ? raw(html`<div><strong>Consent:</strong> ✓ signed by ${booking.consentName} on ${booking.consentSignedAt.toISOString().slice(0, 10)}</div>`) : raw('<div class="muted">Consent: not yet signed</div>')}
          ${booking.appointmentDate ? raw(html`<div><strong>Appointment:</strong> ${booking.appointmentDate.toISOString().slice(0, 16).replace('T', ' ')}</div>`) : ''}
        </div>
        <div class="card stack">
          <h2 style="margin-top:0">Schedule appointment</h2>
          <form method="post" action="/bookings/${booking.id}/schedule" class="stack">
            <label>Appointment date & time<input type="datetime-local" name="appointmentDate" value="${booking.appointmentDate ? booking.appointmentDate.toISOString().slice(0, 16) : ''}" required></label>
            <button type="submit">Save</button>
          </form>
        </div>
        <div class="card stack">
          <h2 style="margin-top:0">Mark as completed</h2>
          <p class="muted">Triggers automated 3-day and 14-day aftercare reminders to ${booking.clientEmail}.</p>
          <form method="post" action="/bookings/${booking.id}/complete">
            <button>Mark completed</button>
          </form>
        </div>
        <div class="card stack">
          <h2 style="margin-top:0">Aftercare status</h2>
          <div>Day 3: ${booking.aftercareDay3At ? raw('<span class="ok">sent ' + booking.aftercareDay3At.toISOString().slice(0, 10) + '</span>') : '<span class="muted">pending</span>'}</div>
          <div>Day 14: ${booking.aftercareDay14At ? raw('<span class="ok">sent ' + booking.aftercareDay14At.toISOString().slice(0, 10) + '</span>') : '<span class="muted">pending</span>'}</div>
        </div>
      `,
    })
  );
});

const scheduleSchema = z.object({ appointmentDate: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'invalid date') });

app.post('/bookings/:id/schedule', async (c) => {
  const user = c.get('user')!;
  const booking = await prisma.booking.findUnique({ where: { id: Number(c.req.param('id')) } });
  if (!booking || booking.userId !== user.id) return c.notFound();
  const form = await c.req.formData();
  const parsed = scheduleSchema.safeParse({ appointmentDate: form.get('appointmentDate') });
  if (!parsed.success) return c.text('Invalid date', 400);
  await prisma.booking.update({
    where: { id: booking.id },
    data: { appointmentDate: new Date(parsed.data.appointmentDate) },
  });
  return c.redirect(`/bookings/${booking.id}`);
});

app.post('/bookings/:id/complete', async (c) => {
  const user = c.get('user')!;
  const booking = await prisma.booking.findUnique({ where: { id: Number(c.req.param('id')) } });
  if (!booking || booking.userId !== user.id) return c.notFound();
  await prisma.booking.update({
    where: { id: booking.id },
    data: {
      status: 'completed',
      // If artist forgot to schedule a date, treat "now" as the appointment date for aftercare counting
      appointmentDate: booking.appointmentDate ?? new Date(),
    },
  });
  return c.redirect(`/bookings/${booking.id}`);
});

app.post('/bookings/:id/cancel', async (c) => {
  const user = c.get('user')!;
  const booking = await prisma.booking.findUnique({ where: { id: Number(c.req.param('id')) } });
  if (!booking || booking.userId !== user.id) return c.notFound();
  await prisma.booking.update({
    where: { id: booking.id },
    data: { status: 'cancelled' },
  });
  return c.redirect(`/bookings/${booking.id}`);
});

// ---------- stripe webhook ----------

app.post('/webhooks/stripe', async (c) => {
  const body = await c.req.text();
  const sig = c.req.header('stripe-signature') ?? '';
  const event = await verifyWebhookEvent(body, sig);
  if (!event) return c.text('Invalid signature', 400);
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as { metadata?: { booking_id?: string } };
    const bookingId = Number(session.metadata?.booking_id);
    if (bookingId) {
      await prisma.booking.updateMany({
        where: { id: bookingId, status: 'pending' },
        data: { status: 'deposit_paid', depositPaidAt: new Date() },
      });
    }
  }
  return c.text('ok');
});

// ---------- session cleanup ----------

async function cleanExpiredSessions() {
  const result = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  if (result.count > 0) console.log(`[cleanup] deleted ${result.count} expired sessions`);
}

// ---------- start ----------

const port = Number(process.env.PORT ?? 3002);
serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`Tattoo Studio OS listening on http://localhost:${info.port}`);
  // eslint-disable-next-line no-console
  console.log(`Stripe: ${stripeEnabled ? 'live keys' : 'demo mode (no key set)'}`);
  startAftercareScheduler();
  setInterval(cleanExpiredSessions, 60 * 60 * 1000); cleanExpiredSessions();
});

export default app;
