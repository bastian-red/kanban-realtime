import type { SessionUser } from '@kan/shared';
import { mintServiceToken } from '@kan/shared/server';
import { redirect } from 'next/navigation';
import type { z } from 'zod';

import { auth } from '../auth';
import { apiRequest, type RequestOptions } from './api';
import { authSecret } from './config';

/**
 * The bridge between the Auth.js session and the two stateless services.
 *
 * Kept out of `lib/api.ts` on purpose. `api.ts` is pure request plumbing with no
 * dependency on next-auth, which is what lets its test exercise it in a plain
 * node environment without mocking half the framework. Everything that needs a
 * signed-in user lives here instead.
 *
 * The token itself is minted by `@kan/shared/server`, not by a function in this
 * app. Three processes take part in one format -- this one signs, the API and the
 * gateway verify -- and when the signing side and the verifying side were two
 * files in two apps, a claim added to one and not read by the others was silent:
 * the token still verified and the field simply arrived undefined.
 */

/** The signed-in user, or null. Never redirects: some callers want the null. */
export async function currentUser(): Promise<SessionUser | null> {
  const session = await auth();
  return session?.user ?? null;
}

/**
 * The signed-in user, or a redirect to the login page.
 *
 * `redirect()` throws a `NEXT_REDIRECT` error that Next catches upstream, so it
 * is called outside any try/catch here and must stay that way. Wrapping it is the
 * single most expensive mistake available in this file: the catch swallows the
 * throw, the function returns, and the page renders for an anonymous visitor.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}

/** A token for the signed-in user, for the API or for a socket handshake. */
export function tokenFor(user: SessionUser): string {
  return mintServiceToken({ id: user.id, email: user.email, name: user.name }, authSecret());
}

/**
 * An API call as the signed-in user.
 *
 * The token is minted per call rather than cached. It costs an HMAC, it lives two
 * minutes, and caching it would mean holding a bearer credential in a module
 * scope shared by every request the Next server handles.
 */
export async function authedRequest<T>(
  path: string,
  // See `apiRequest`: the three-parameter form is what lets a transforming
  // schema through with its output type intact.
  schema: z.ZodType<T, z.ZodTypeDef, unknown> | null,
  options: RequestOptions = {},
): Promise<T> {
  const user = await requireUser();
  return apiRequest(path, schema, { ...options, token: tokenFor(user) });
}
