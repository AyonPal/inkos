// Aftercare scheduling. The "aftercare" feature in this MVP is a database-driven
// scheduled job: every minute we look for completed bookings whose 3-day or 14-day
// aftercare timestamps are due and we mark them sent. In production this would
// also fire an email or SMS — wired through any of: Resend, Postmark, Twilio.
//
// The job is intentionally idempotent: it sets `aftercareDay3At` / `aftercareDay14At`
// to "now" so the next pass skips them. Replace `deliverAftercare()` with your
// real notification provider.

import { prisma } from './db.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;

export type AftercareDelivery = {
  bookingId: number;
  clientEmail: string;
  clientName: string;
  stage: 'day3' | 'day14';
};

// Override this in tests or to inject a real notification provider.
export let deliverAftercare: (msg: AftercareDelivery) => Promise<void> = async (msg) => {
  // eslint-disable-next-line no-console
  console.log(`[aftercare] would send ${msg.stage} reminder to ${msg.clientEmail} (booking ${msg.bookingId})`);
};

export function setAftercareDelivery(fn: (msg: AftercareDelivery) => Promise<void>): void {
  deliverAftercare = fn;
}

export async function runAftercareSweep(now = new Date()): Promise<number> {
  let sent = 0;

  const day3Due = await prisma.booking.findMany({
    where: {
      status: { in: ['completed', 'consented'] },
      appointmentDate: { lte: new Date(now.getTime() - 3 * DAY_MS) },
      aftercareDay3At: null,
    },
  });

  for (const b of day3Due) {
    await deliverAftercare({
      bookingId: b.id,
      clientEmail: b.clientEmail,
      clientName: b.clientName,
      stage: 'day3',
    });
    await prisma.booking.update({
      where: { id: b.id },
      data: { aftercareDay3At: now },
    });
    sent++;
  }

  const day14Due = await prisma.booking.findMany({
    where: {
      status: { in: ['completed', 'consented'] },
      appointmentDate: { lte: new Date(now.getTime() - 14 * DAY_MS) },
      aftercareDay14At: null,
    },
  });

  for (const b of day14Due) {
    await deliverAftercare({
      bookingId: b.id,
      clientEmail: b.clientEmail,
      clientName: b.clientName,
      stage: 'day14',
    });
    await prisma.booking.update({
      where: { id: b.id },
      data: { aftercareDay14At: now },
    });
    sent++;
  }

  return sent;
}

export function startAftercareScheduler(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    runAftercareSweep().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[aftercare] sweep failed:', err);
    });
  }, intervalMs);
}

export function stopAftercareScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
