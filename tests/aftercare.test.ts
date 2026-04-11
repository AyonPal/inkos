import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { execSync } from 'node:child_process';

// Use a unique sqlite db per test run so we don't pollute the dev db.
const TEST_DB = `./data/test-${process.pid}.db`;
process.env.DATABASE_URL = `file:${TEST_DB}`;
process.env.NODE_ENV = 'test';

const { prisma } = await import('../src/db.ts');
const { runAftercareSweep, setAftercareDelivery } = await import('../src/aftercare.ts');

beforeEach(async () => {
  await mkdir('./data', { recursive: true });
  // Apply schema directly (faster than running migrate dev for tests).
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB}` },
    stdio: 'pipe',
  });
});

afterEach(async () => {
  await prisma.$disconnect();
  await rm(TEST_DB, { force: true });
  await rm(`${TEST_DB}-journal`, { force: true });
});

const DAY = 24 * 60 * 60 * 1000;

describe('aftercare sweep', () => {
  it('sends day-3 reminder for completed bookings older than 3 days', async () => {
    const user = await prisma.user.create({
      data: { email: 'a@b.c', passwordHash: 'x:y', bookingSlug: `t-${Date.now()}` },
    });
    const fourDaysAgo = new Date(Date.now() - 4 * DAY);
    await prisma.booking.create({
      data: {
        userId: user.id,
        clientName: 'Bob',
        clientEmail: 'bob@example.com',
        description: 'small flash on forearm',
        preferredDate: fourDaysAgo,
        appointmentDate: fourDaysAgo,
        depositCents: 5000,
        status: 'completed',
      },
    });

    const sent: string[] = [];
    setAftercareDelivery(async (m) => {
      sent.push(`${m.stage}:${m.clientEmail}`);
    });

    const count = await runAftercareSweep();
    expect(count).toBe(1);
    expect(sent).toEqual(['day3:bob@example.com']);
  });

  it('does not double-send the same stage', async () => {
    const user = await prisma.user.create({
      data: { email: 'c@d.e', passwordHash: 'x:y', bookingSlug: `t-${Date.now()}-2` },
    });
    const fourDaysAgo = new Date(Date.now() - 4 * DAY);
    await prisma.booking.create({
      data: {
        userId: user.id,
        clientName: 'Carol',
        clientEmail: 'carol@example.com',
        description: 'fine line tattoo',
        preferredDate: fourDaysAgo,
        appointmentDate: fourDaysAgo,
        depositCents: 5000,
        status: 'completed',
      },
    });

    let calls = 0;
    setAftercareDelivery(async () => {
      calls++;
    });
    await runAftercareSweep();
    await runAftercareSweep();
    expect(calls).toBe(1);
  });

  it('sends day-14 reminder for bookings older than 14 days', async () => {
    const user = await prisma.user.create({
      data: { email: 'e@f.g', passwordHash: 'x:y', bookingSlug: `t-${Date.now()}-3` },
    });
    const fifteenDaysAgo = new Date(Date.now() - 15 * DAY);
    await prisma.booking.create({
      data: {
        userId: user.id,
        clientName: 'Dee',
        clientEmail: 'dee@example.com',
        description: 'sleeve',
        preferredDate: fifteenDaysAgo,
        appointmentDate: fifteenDaysAgo,
        depositCents: 5000,
        status: 'completed',
        aftercareDay3At: new Date(Date.now() - 12 * DAY),
      },
    });

    const sent: string[] = [];
    setAftercareDelivery(async (m) => {
      sent.push(m.stage);
    });
    await runAftercareSweep();
    expect(sent).toEqual(['day14']);
  });

  it('does not send anything for fresh bookings', async () => {
    const user = await prisma.user.create({
      data: { email: 'h@i.j', passwordHash: 'x:y', bookingSlug: `t-${Date.now()}-4` },
    });
    await prisma.booking.create({
      data: {
        userId: user.id,
        clientName: 'Eve',
        clientEmail: 'eve@example.com',
        description: 'tiny dot',
        preferredDate: new Date(),
        appointmentDate: new Date(),
        depositCents: 5000,
        status: 'completed',
      },
    });
    let called = 0;
    setAftercareDelivery(async () => {
      called++;
    });
    const count = await runAftercareSweep();
    expect(count).toBe(0);
    expect(called).toBe(0);
  });
});
