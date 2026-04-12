import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/crypto.ts';

describe('password hashing (PBKDF2)', () => {
  it('verifies a correct password', async () => {
    const stored = await hashPassword('correcthorsebattery');
    expect(await verifyPassword('correcthorsebattery', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correcthorsebattery');
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });

  it('produces different hashes for the same password (salt)', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toEqual(b);
  });
});
