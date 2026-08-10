import 'reflect-metadata';
import { mintServiceToken, type TokenUser } from '@kan/shared/server';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import type { ApiConfig } from '../config/config';
import { loadConfig } from '../config/config';
import { IS_PUBLIC_KEY } from './public.decorator';
import { authenticate, ServiceTokenGuard, REQUEST_USER } from './service-token.guard';

/**
 * What this file covers, and what it deliberately does not.
 *
 * The token *format* -- the pinned algorithm, the required claims, the refusal of
 * `alg: none` -- is tested once, in `packages/shared/src/server/service-token.test.ts`,
 * because three processes verify the same token and testing it per process is
 * three copies that can pass while disagreeing. What is this app's own is the
 * mapping from a failure to a framework 401, and the `@Public()` bypass.
 */
const SECRET = 'test-secret-at-least-sixteen-chars';
const USER: TokenUser = { id: 'usr_7', email: 'seven@kanban.local', name: 'Seven Ruiz' };

const config = (): ApiConfig =>
  loadConfig({
    DATABASE_URL: 'postgresql://kan:kan@localhost:5437/kan',
    REDIS_URL: 'redis://localhost:6384',
    AUTH_SECRET: SECRET,
  });

interface FakeRequest {
  headers: Record<string, string | undefined>;
  [REQUEST_USER]?: unknown;
}

const contextFor = (request: FakeRequest, handler: () => void = () => {}): never =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => class Anonymous {},
  }) as never;

describe('authenticate', () => {
  it('returns the caller for a well-formed header', () => {
    expect(authenticate(`Bearer ${mintServiceToken(USER, SECRET)}`, SECRET)).toEqual(USER);
  });

  it('accepts a lower-case scheme, because RFC 7235 says the scheme is case-insensitive', () => {
    expect(authenticate(`bearer ${mintServiceToken(USER, SECRET)}`, SECRET)).toEqual(USER);
  });

  it.each([
    ['a missing header', undefined],
    ['a header with no scheme', 'abc.def.ghi'],
    ['a Basic header', 'Basic dXNlcjpwYXNz'],
  ])('refuses %s', (_label, header) => {
    expect(() => authenticate(header, SECRET)).toThrow(UnauthorizedException);
  });

  it('refuses a token signed with a different secret', () => {
    const token = mintServiceToken(USER, 'a-completely-different-secret');
    expect(() => authenticate(`Bearer ${token}`, SECRET)).toThrow(UnauthorizedException);
  });

  it('gives the same message for every token failure, so it is not an oracle', () => {
    // Expired, wrong secret and garbage must be indistinguishable in the
    // response: telling a client which one it was says which half of the token to
    // keep working on.
    const messages = new Set<string>();
    const attempts = [
      mintServiceToken(USER, SECRET, -1),
      jwt.sign({ sub: 'usr_1', email: 'a@b.c', name: 'A' }, 'another-secret-entirely'),
      'garbage',
    ];
    for (const token of attempts) {
      try {
        authenticate(`Bearer ${token}`, SECRET);
      } catch (error) {
        messages.add(error instanceof Error ? error.message : String(error));
      }
    }
    expect(messages.size).toBe(1);
  });
});

describe('ServiceTokenGuard', () => {
  const guard = (): ServiceTokenGuard => new ServiceTokenGuard(new Reflector(), config());

  it('parks the verified caller on the request', () => {
    const request: FakeRequest = {
      headers: { authorization: `Bearer ${mintServiceToken(USER, SECRET)}` },
    };
    expect(guard().canActivate(contextFor(request))).toBe(true);
    expect(request[REQUEST_USER]).toEqual(USER);
  });

  it('refuses a request with no Authorization header', () => {
    expect(() => guard().canActivate(contextFor({ headers: {} }))).toThrow(UnauthorizedException);
  });

  it('lets a @Public() handler through with no token at all', () => {
    // The metadata is read off the handler, so this is the real decorator path
    // rather than a stub of it.
    // `IS_PUBLIC_KEY`, not the string it currently holds. A literal here passes
    // for as long as the two happen to agree and silently stops testing the
    // decorator the moment somebody renames the key.
    const handler = (): void => {};
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
    expect(guard().canActivate(contextFor({ headers: {} }, handler))).toBe(true);
  });
});
