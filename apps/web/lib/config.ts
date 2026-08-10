/**
 * Everything the web app reads out of the environment, in one place.
 *
 * Each reader takes `env` as a defaulted parameter rather than closing over
 * `process.env` at module scope. Two reasons, and the second is the one that
 * matters:
 *
 * - a unit test can hand it a fake environment without mutating the real one,
 *   which is what lets `config.test.ts` prove the fallbacks;
 * - `scripts/env-contract.mjs` scans source for `process.env.NAME` and `env.NAME`
 *   and cross-checks the result against `turbo.json` and `.env.example`. Turbo 2
 *   runs in strict env mode, so a name the code reads but nobody declared is
 *   stripped silently and arrives as `undefined`. Keeping the reads in this shape
 *   keeps them visible to that scanner.
 *
 * The two `NEXT_PUBLIC_` reads are the exception, and they are deliberate.
 */

/**
 * The environment, as this app reads it.
 *
 * `Record<string, string | undefined>` rather than `NodeJS.ProcessEnv`. Next's
 * ambient types narrow `ProcessEnv` so that `NODE_ENV` is required, which makes
 * every `{ AUTH_SECRET: 'x' }` fixture in `config.test.ts` a type error over a
 * variable none of these readers touch. The wider type is also the honest one: a
 * name turbo stripped in strict env mode arrives as `undefined`, and that is
 * exactly what each fallback below exists to handle.
 */
export type WebEnv = Record<string, string | undefined>;

/** Server-to-server base URL. Inside compose this is the service name, not localhost. */
export function apiBaseUrl(env: WebEnv = process.env): string {
  return env.API_BASE_URL ?? 'http://localhost:4000';
}

/**
 * The gateway, server-side.
 *
 * Only the `/status` page uses it: the browser opens its own socket, and the
 * server never does. Inside compose this is `http://realtime:4100`, which
 * resolves for the Next server and for nobody else.
 */
export function realtimeBaseUrl(env: WebEnv = process.env): string {
  return env.REALTIME_BASE_URL ?? 'http://localhost:4100';
}

/**
 * The second gateway replica, when one is running.
 *
 * The /status page probes both, because "the gateway is up" is the wrong
 * question for a process whose whole point is that there are several of it. One
 * replica green and one red is the state that produces the product's worst
 * symptom -- half the people on a board see each other and half do not -- and it
 * is invisible if the page only ever asks the replica it happens to reach.
 */
export function realtimeReplicaUrl(env: WebEnv = process.env): string | null {
  return env.REALTIME_BASE_URL_2 ?? null;
}

/**
 * The API URL as the *browser* would have to reach it.
 *
 * Written as a literal `process.env.NEXT_PUBLIC_API_BASE_URL` rather than through
 * an `env` parameter, because Next inlines `NEXT_PUBLIC_*` by textual
 * substitution at build time. Read through a variable it would not be replaced,
 * and the client bundle would see `undefined`.
 */
export const PUBLIC_API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

/**
 * The socket URL the browser connects to. Baked into the bundle at build time.
 *
 * This one is not a convenience link like the API's: it is the address of the
 * WebSocket the board actually opens, so `next build` has to inline the value
 * the deployed browser will use. Building with the wrong one produces an app
 * that renders a board and never moves it, with a CORS error in a console nobody
 * has open.
 */
export const PUBLIC_REALTIME_URL = process.env.NEXT_PUBLIC_REALTIME_URL ?? 'http://localhost:4100';

/** Absolute origin of this app, used as the metadata base for canonical URLs. */
export function appBaseUrl(env: WebEnv = process.env): string {
  return env.APP_BASE_URL ?? 'http://localhost:3000';
}

/**
 * How often the browser refreshes its presence entry, in seconds.
 *
 * Read here and passed into the client rather than hardcoded there, because the
 * gateway refuses to start unless `PRESENCE_TTL_SECONDS` is more than twice this
 * (`apps/realtime/src/boot.ts`). Two constants that must satisfy an inequality
 * have to come from one place, or the day somebody raises the TTL the client
 * keeps heartbeating at the old rate and nobody notices until a board of people
 * starts flickering out of the roster.
 */
export function presenceHeartbeatSeconds(env: WebEnv = process.env): number {
  const raw = Number(env.PRESENCE_HEARTBEAT_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10;
}

/**
 * The secret shared with the API and the gateway, used to sign the service token.
 *
 * Throws rather than defaulting. A default here would mint tokens neither of them
 * can verify, and every authenticated request and every socket handshake would
 * fail with a 401 that says nothing about the missing configuration.
 */
export function authSecret(env: WebEnv = process.env): string {
  const secret = env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      'AUTH_SECRET is missing or shorter than 16 characters. The web app signs the ' +
        'service token the API and the gateway verify, so without it no authenticated ' +
        'request and no socket handshake can succeed.',
    );
  }
  return secret;
}
