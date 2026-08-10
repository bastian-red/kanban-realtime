/**
 * Everything the gateway reads from the environment, read once, in one place.
 *
 * Deliberately the same shape as `apps/api/src/config/config.ts`, down to the
 * `env` parameter and the `ENV_NAME_FOR` map, and for the same two reasons.
 *
 * **`env` is a parameter with a default.** `loadConfig(fake)` is how every branch
 * below gets a unit test without touching `process.env`. It is also what
 * `scripts/env-contract.mjs` can see: the scanner matches `env.NAME`, so a name
 * read through a helper, a destructure or a loop over a list of keys is invisible
 * to it, and an invisible read is exactly the one that goes undeclared in
 * `turbo.json` and gets stripped in strict mode.
 *
 * **It throws, naming the variable.** A gateway that boots with `AUTH_SECRET`
 * undefined does not fail at boot: every socket handshake fails instead, which
 * presents to a user as a board that renders and never moves -- the hardest
 * symptom in this product to trace back to a missing variable.
 */
import { z } from 'zod';

/**
 * Mirrors the `version` field of `apps/realtime/package.json`.
 *
 * A constant rather than an import of the manifest: `rootDir` is `src`, so
 * reaching up to `../package.json` puts a file outside the compilation root and
 * `tsc` refuses. `APP_VERSION` is what a real deployment sets anyway, from the
 * image tag; this is the value that shows up when nobody set it.
 */
export const PACKAGE_VERSION = '0.1.0';

export type NodeEnvironment = 'development' | 'test' | 'production';

export interface RealtimeConfig {
  nodeEnv: NodeEnvironment;
  port: number;
  version: string;
  databaseUrl: string;
  redisUrl: string;
  authSecret: string;
  /** Allowed browser origin for the socket handshake. */
  appBaseUrl: string;
  moveRetryAttempts: number;
  presence: {
    heartbeatSeconds: number;
    ttlSeconds: number;
  };
  socket: {
    maxPayloadBytes: number;
    /** Events per minute, per socket. */
    eventRateLimit: number;
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** An empty string is an unset variable. `.env` files are full of `NAME=`. */
const blankToUndefined = (value: unknown): unknown =>
  value === undefined || value === null || value === '' ? undefined : value;

const toNumber = (value: unknown): unknown =>
  blankToUndefined(value) === undefined ? undefined : Number(value);

/**
 * Defaults and `.optional()` sit on the **inner** schema, never outside the
 * preprocess.
 *
 * `z.preprocess(fn, schema).default(x)` never applies the default, because
 * preprocess always produces a value (`undefined` counts) and zod only reaches a
 * default when the field is absent. The result is `NaN` where a number was
 * expected, several layers from here.
 */
const port = (fallback: number) =>
  z.preprocess(toNumber, z.number().int().min(1).max(65_535).default(fallback));

const count = (fallback: number, max: number) =>
  z.preprocess(toNumber, z.number().int().min(1).max(max).default(fallback));

const schema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  port: port(4100),
  version: z.string().min(1).default(PACKAGE_VERSION),
  databaseUrl: z.string().min(1, 'DATABASE_URL is required'),
  redisUrl: z.string().min(1, 'REDIS_URL is required'),
  // 16, matching scripts/dev.sh's check and the API's. All three have to agree or
  // `pnpm dev` passes its own preflight and a process then refuses to start.
  authSecret: z.string().min(16, 'AUTH_SECRET must be at least 16 characters'),
  appBaseUrl: z.string().min(1),
  moveRetryAttempts: count(5, 20),
  presence: z.object({
    heartbeatSeconds: count(10, 300),
    ttlSeconds: count(25, 900),
  }),
  socket: z.object({
    // 64 KB. A card's title, description and move intent are all well under 1 KB.
    maxPayloadBytes: count(65_536, 1_048_576),
    eventRateLimit: count(240, 100_000),
  }),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RealtimeConfig {
  const parsed = schema.safeParse({
    nodeEnv: blankToUndefined(env.NODE_ENV),
    // PORT wins over REALTIME_PORT: it is the name every container runtime
    // injects, and it is how infra/docker-compose.yml runs a second replica of
    // this exact image on 4101 without a second image.
    port: blankToUndefined(env.PORT) ?? blankToUndefined(env.REALTIME_PORT),
    version: blankToUndefined(env.APP_VERSION),
    databaseUrl: blankToUndefined(env.DATABASE_URL),
    redisUrl: blankToUndefined(env.REDIS_URL),
    authSecret: blankToUndefined(env.AUTH_SECRET),
    appBaseUrl: blankToUndefined(env.APP_BASE_URL) ?? 'http://localhost:3000',
    moveRetryAttempts: blankToUndefined(env.MOVE_RETRY_ATTEMPTS),
    presence: {
      heartbeatSeconds: blankToUndefined(env.PRESENCE_HEARTBEAT_SECONDS),
      ttlSeconds: blankToUndefined(env.PRESENCE_TTL_SECONDS),
    },
    socket: {
      maxPayloadBytes: blankToUndefined(env.SOCKET_MAX_PAYLOAD_BYTES),
      eventRateLimit: blankToUndefined(env.SOCKET_EVENT_RATE_LIMIT),
    },
  });

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map(
        (issue) =>
          `  ${ENV_NAME_FOR[issue.path.join('.')] ?? issue.path.join('.')}: ${issue.message}`,
      )
      .join('\n');
    throw new ConfigError(`The realtime gateway cannot start. Fix these in .env:\n${problems}`);
  }

  return parsed.data;
}

/** Schema field path -> the environment variable a reader sets. */
const ENV_NAME_FOR: Record<string, string> = {
  nodeEnv: 'NODE_ENV',
  port: 'PORT (or REALTIME_PORT)',
  version: 'APP_VERSION',
  databaseUrl: 'DATABASE_URL',
  redisUrl: 'REDIS_URL',
  authSecret: 'AUTH_SECRET',
  appBaseUrl: 'APP_BASE_URL',
  moveRetryAttempts: 'MOVE_RETRY_ATTEMPTS',
  'presence.heartbeatSeconds': 'PRESENCE_HEARTBEAT_SECONDS',
  'presence.ttlSeconds': 'PRESENCE_TTL_SECONDS',
  'socket.maxPayloadBytes': 'SOCKET_MAX_PAYLOAD_BYTES',
  'socket.eventRateLimit': 'SOCKET_EVENT_RATE_LIMIT',
};
