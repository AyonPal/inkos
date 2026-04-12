import { describe, expect, it, beforeEach } from 'vitest';
import { runAftercareSweep, setAftercareDelivery } from '../src/aftercare.ts';

/**
 * Minimal D1Database stub for testing the aftercare sweep logic.
 * Only implements the subset of the D1 API used by runAftercareSweep.
 */
function createTestDb(bookings: any[]) {
  // In-memory store keyed by id
  const store = new Map(bookings.map((b) => [b.id, { ...b }]));

  const db = {
    prepare(sql: string) {
      return {
        _sql: sql,
        _binds: [] as any[],
        bind(...args: any[]) {
          this._binds = args;
          return this;
        },
        async all<T>(): Promise<{ results: T[] }> {
          // Match SELECT queries for day3 or day14
          const isDay3 = this._sql.includes('aftercare_day3_at IS NULL');
          const isDay14 = this._sql.includes('aftercare_day14_at IS NULL') && !isDay3;
          const cutoff = this._binds[0] as string;
          const results: any[] = [];
          for (const b of store.values()) {
            if (!['completed', 'consented'].includes(b.status)) continue;
            if (!b.appointment_date) continue;
            if (b.appointment_date > cutoff) continue;
            if (isDay3 && b.aftercare_day3_at === null) results.push(b);
            if (isDay14 && b.aftercare_day14_at === null) results.push(b);
          }
          return { results: results as T[] };
        },
        async run() {
          // Match UPDATE queries
          if (this._sql.includes('aftercare_day3_at')) {
            const id = this._binds[1];
            const b = store.get(id);
            if (b) b.aftercare_day3_at = this._binds[0];
          }
          if (this._sql.includes('aftercare_day14_at')) {
            const id = this._binds[1];
            const b = store.get(id);
            if (b) b.aftercare_day14_at = this._binds[0];
          }
        },
      };
    },
  } as unknown as D1Database;

  return { db, store };
}

const DAY = 24 * 60 * 60 * 1000;

describe('aftercare sweep', () => {
  it('sends day-3 reminder for completed bookings older than 3 days', async () => {
    const fourDaysAgo = new Date(Date.now() - 4 * DAY).toISOString();
    const { db } = createTestDb([
      {
        id: 1,
        client_email: 'bob@example.com',
        client_name: 'Bob',
        status: 'completed',
        appointment_date: fourDaysAgo,
        aftercare_day3_at: null,
        aftercare_day14_at: null,
      },
    ]);

    const sent: string[] = [];
    setAftercareDelivery(async (m) => {
      sent.push(`${m.stage}:${m.clientEmail}`);
    });

    const count = await runAftercareSweep(db);
    expect(count).toBe(1);
    expect(sent).toEqual(['day3:bob@example.com']);
  });

  it('does not double-send the same stage', async () => {
    const fourDaysAgo = new Date(Date.now() - 4 * DAY).toISOString();
    const { db } = createTestDb([
      {
        id: 1,
        client_email: 'carol@example.com',
        client_name: 'Carol',
        status: 'completed',
        appointment_date: fourDaysAgo,
        aftercare_day3_at: null,
        aftercare_day14_at: null,
      },
    ]);

    let calls = 0;
    setAftercareDelivery(async () => {
      calls++;
    });
    await runAftercareSweep(db);
    await runAftercareSweep(db);
    expect(calls).toBe(1);
  });

  it('sends day-14 reminder for bookings older than 14 days', async () => {
    const fifteenDaysAgo = new Date(Date.now() - 15 * DAY).toISOString();
    const { db } = createTestDb([
      {
        id: 1,
        client_email: 'dee@example.com',
        client_name: 'Dee',
        status: 'completed',
        appointment_date: fifteenDaysAgo,
        aftercare_day3_at: new Date(Date.now() - 12 * DAY).toISOString(),
        aftercare_day14_at: null,
      },
    ]);

    const sent: string[] = [];
    setAftercareDelivery(async (m) => {
      sent.push(m.stage);
    });
    await runAftercareSweep(db);
    expect(sent).toEqual(['day14']);
  });

  it('does not send anything for fresh bookings', async () => {
    const { db } = createTestDb([
      {
        id: 1,
        client_email: 'eve@example.com',
        client_name: 'Eve',
        status: 'completed',
        appointment_date: new Date().toISOString(),
        aftercare_day3_at: null,
        aftercare_day14_at: null,
      },
    ]);

    let called = 0;
    setAftercareDelivery(async () => {
      called++;
    });
    const count = await runAftercareSweep(db);
    expect(count).toBe(0);
    expect(called).toBe(0);
  });
});
