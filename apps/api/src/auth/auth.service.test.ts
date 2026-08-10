import type { User } from '@kan/db';
import { hashPassword } from '@kan/shared/server';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { AuthService, sessionUserOf, STARTER_BOARD_NAME, STARTER_LIST_NAMES } from './auth.service';

const PASSWORD = 'correct-horse-battery';

const row = (overrides: Partial<User> = {}): User =>
  ({
    id: 'usr_1',
    email: 'ana@kanban.local',
    name: 'Ana Ruiz',
    passwordHash: hashPassword(PASSWORD),
    timeZone: 'Europe/Madrid',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }) as User;

/**
 * The narrowest fake that exercises the real code path.
 *
 * `findUnique` is the only method `login` and `profile` touch, so the fake is
 * four lines rather than a mock of the whole client. Nothing here reaches a
 * database, which is what keeps this in the gate lane; signup's transaction is
 * proved against real Postgres in the integration lane, because a fake
 * `$transaction` that always commits cannot prove the rollback that method
 * exists for.
 */
const serviceWith = (user: User | null): AuthService =>
  new AuthService({
    user: { findUnique: () => Promise.resolve(user) },
  } as unknown as PrismaService);

describe('sessionUserOf', () => {
  it('never carries the password hash', () => {
    // The assertion is on the key set, not on `result.passwordHash` being
    // undefined. Reading one property by name only catches the leak somebody
    // already thought of; the key set catches the field added next year.
    const result = sessionUserOf(row());
    expect(Object.keys(result).sort()).toEqual(['email', 'id', 'name', 'timeZone']);
    expect(JSON.stringify(result)).not.toContain('scrypt');
  });
});

describe('AuthService.login', () => {
  it('accepts the right password', async () => {
    const user = await serviceWith(row()).login({ email: 'ana@kanban.local', password: PASSWORD });
    expect(user.id).toBe('usr_1');
  });

  it('refuses a missing account and a wrong password with the same sentence', async () => {
    // The user-enumeration property, expressed as something a test can check.
    // Timing is the other half and is not deterministic enough to gate on; the
    // wording is, and a divergence here ("no such user" vs "wrong password") is
    // how the oracle usually gets reintroduced.
    const missing = await serviceWith(null)
      .login({ email: 'nobody@kanban.local', password: PASSWORD })
      .catch((error: unknown) => error);
    const wrong = await serviceWith(row())
      .login({ email: 'ana@kanban.local', password: 'not-the-password' })
      .catch((error: unknown) => error);

    expect(missing).toBeInstanceOf(UnauthorizedException);
    expect(wrong).toBeInstanceOf(UnauthorizedException);
    expect((missing as UnauthorizedException).message).toBe(
      (wrong as UnauthorizedException).message,
    );
    expect((missing as UnauthorizedException).message).not.toMatch(/exist|unknown|found/i);
  });

  it('runs the hash comparison even when there is no account', async () => {
    // The dummy-hash path. Without it the missing-account branch returns without
    // touching scrypt, and the timing difference is the enumeration oracle the
    // matching message above was meant to close. Asserted by cost: a call that
    // skipped scrypt entirely would be far below this floor.
    const startedAt = performance.now();
    await serviceWith(null)
      .login({ email: 'nobody@kanban.local', password: PASSWORD })
      .catch(() => undefined);
    expect(performance.now() - startedAt).toBeGreaterThan(1);
  });

  it('lower-cases the address before looking it up', async () => {
    // Postgres is case-sensitive and `users_email_key` is a plain unique index,
    // so "Ana@..." and "ana@..." are two different rows to the database. Signup
    // stores the lower-cased form; login has to look up the same way or the
    // account becomes unreachable from a capitalised address.
    const findUnique = vi.fn().mockResolvedValue(row());
    const service = new AuthService({ user: { findUnique } } as unknown as PrismaService);
    await service.login({ email: 'Ana@Kanban.Local', password: PASSWORD });
    expect(findUnique).toHaveBeenCalledWith({ where: { email: 'ana@kanban.local' } });
  });
});

describe('AuthService.profile', () => {
  it('refuses a token for an account that no longer exists', async () => {
    // A valid signature for a deleted user. The token stays cryptographically
    // good until it expires, so the row has to be the authority.
    await expect(serviceWith(null).profile('usr_gone')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('the starter board', () => {
  it('opens three named columns', () => {
    expect([...STARTER_LIST_NAMES]).toEqual(['Backlog', 'In progress', 'Done']);
    expect(STARTER_BOARD_NAME).toBe('My first board');
  });

  it('is not empty, because a board with no lists cannot accept a card', () => {
    expect(STARTER_LIST_NAMES.length).toBeGreaterThan(0);
  });
});

describe('signup', () => {
  it('reports a duplicate address as a conflict, not a crash', async () => {
    // P2002 on `users_email_key` is the one failure this route can hit that the
    // caller can act on. Anything else has to keep propagating, so the fake
    // throws a shaped error rather than a bare one.
    const service = new AuthService({
      $transaction: () =>
        Promise.reject(
          Object.assign(new Error('Unique constraint failed'), {
            code: 'P2002',
            meta: { target: 'users_email_key' },
          }),
        ),
    } as unknown as PrismaService);

    await expect(
      service.signup({ email: 'ana@kanban.local', password: PASSWORD, name: 'Ana' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('lets an unrelated failure propagate', async () => {
    // The trap this avoids: catching every error and calling it a duplicate
    // email. A dead database would then answer 409 "that address is taken",
    // which is a lie that sends the user to the login page.
    const service = new AuthService({
      $transaction: () => Promise.reject(new Error('connection refused')),
    } as unknown as PrismaService);

    await expect(
      service.signup({ email: 'ana@kanban.local', password: PASSWORD, name: 'Ana' }),
    ).rejects.toThrow('connection refused');
  });
});
