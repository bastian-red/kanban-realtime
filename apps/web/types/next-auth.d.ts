import type { SessionUser } from '@kan/shared';

/**
 * What this app's session actually holds.
 *
 * Auth.js ships a `User` of `{ id?, name?, email?, image? }`, and every one of
 * those is optional. This app needs three of them to be present rather than
 * possibly-undefined, because all three go into the service token: `id` is the
 * subject every permission check reads, `email` identifies the caller, and `name`
 * is the actor on every activity line the board broadcasts. A token minted with
 * `name: undefined` is refused by both verifiers, and the symptom is a board that
 * renders and never moves.
 *
 * So the session's user is the contract's `SessionUser`, which is the same shape
 * the API answers `/auth/login` with, parsed rather than cast. `auth.ts` is what
 * guarantees the type is not a lie: the jwt callback refuses to mint a token it
 * cannot parse into this shape, and the session callback returns a session with
 * no user at all rather than a half-built one.
 */
declare module 'next-auth' {
  interface Session {
    user: SessionUser;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    /**
     * Namespaced rather than spread across the token's own `name`/`email`
     * fields, which Auth.js writes itself and would overwrite.
     */
    kan?: SessionUser;
  }
}
