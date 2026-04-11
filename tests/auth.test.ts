import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth.ts';

describe('password hashing', () => {
  it('verifies a correct password', () => {
    const stored = hashPassword('correcthorsebattery');
    expect(verifyPassword('correcthorsebattery', stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword('correcthorsebattery');
    expect(verifyPassword('wrong', stored)).toBe(false);
  });

  it('produces different hashes for the same password (salt)', () => {
    expect(hashPassword('same')).not.toEqual(hashPassword('same'));
  });
});
