// Aftercare scheduling — Cloudflare Workers version.
//
// The sweep runs via Cron Trigger (every minute). It finds completed/consented
// bookings whose 3-day or 14-day aftercare is due, delivers the reminder,
// and marks it sent. Fully idempotent.
//
// The delivery function is injectable via setAftercareDelivery() — in production
// plug in Resend/Postmark/etc. via fetch().

export type AftercareDelivery = {
  bookingId: number;
  clientEmail: string;
  clientName: string;
  stage: 'day3' | 'day14';
};

// Override this to inject a real notification provider.
export let deliverAftercare: (msg: AftercareDelivery) => Promise<void> = async (msg) => {
  console.log(`[aftercare] would send ${msg.stage} reminder to ${msg.clientEmail} (booking ${msg.bookingId})`);
};

export function setAftercareDelivery(fn: (msg: AftercareDelivery) => Promise<void>): void {
  deliverAftercare = fn;
}

const DAY_MS = 24 * 60 * 60 * 1000;

type BookingRow = {
  id: number;
  client_email: string;
  client_name: string;
};

export async function runAftercareSweep(db: D1Database, now = new Date()): Promise<number> {
  let sent = 0;

  // Day-3 reminders
  const day3Cutoff = new Date(now.getTime() - 3 * DAY_MS).toISOString();
  const day3Due = await db
    .prepare(
      `SELECT id, client_email, client_name FROM bookings
       WHERE status IN ('completed','consented')
         AND appointment_date IS NOT NULL
         AND appointment_date <= ?
         AND aftercare_day3_at IS NULL`,
    )
    .bind(day3Cutoff)
    .all<BookingRow>();

  for (const b of day3Due.results) {
    await deliverAftercare({
      bookingId: b.id,
      clientEmail: b.client_email,
      clientName: b.client_name,
      stage: 'day3',
    });
    await db
      .prepare('UPDATE bookings SET aftercare_day3_at = ? WHERE id = ?')
      .bind(now.toISOString(), b.id)
      .run();
    sent++;
  }

  // Day-14 reminders
  const day14Cutoff = new Date(now.getTime() - 14 * DAY_MS).toISOString();
  const day14Due = await db
    .prepare(
      `SELECT id, client_email, client_name FROM bookings
       WHERE status IN ('completed','consented')
         AND appointment_date IS NOT NULL
         AND appointment_date <= ?
         AND aftercare_day14_at IS NULL`,
    )
    .bind(day14Cutoff)
    .all<BookingRow>();

  for (const b of day14Due.results) {
    await deliverAftercare({
      bookingId: b.id,
      clientEmail: b.client_email,
      clientName: b.client_name,
      stage: 'day14',
    });
    await db
      .prepare('UPDATE bookings SET aftercare_day14_at = ? WHERE id = ?')
      .bind(now.toISOString(), b.id)
      .run();
    sent++;
  }

  return sent;
}
