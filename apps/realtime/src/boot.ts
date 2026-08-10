/**
 * Refusals a schema cannot express.
 *
 * `loadConfig` checks the *shape* of every value. This checks values whose shape
 * is fine and whose meaning is not -- the ones that would otherwise fail hours
 * later, on an interaction that has nothing to do with the mistake.
 */
import { assertPresenceConfig, PresenceConfigError } from '@kan/presence';

import { ConfigError } from './config';
import type { RealtimeConfig } from './config';

export function assertBootable(config: RealtimeConfig): void {
  const problems: string[] = [];

  if (!/^https?:\/\//.test(config.appBaseUrl)) {
    problems.push(
      `APP_BASE_URL must be absolute (http:// or https://), got ${JSON.stringify(config.appBaseUrl)}.`,
    );
  }
  if (!/^postgres(ql)?:\/\//.test(config.databaseUrl)) {
    problems.push('DATABASE_URL must start with postgresql://');
  }
  if (!/^rediss?:\/\//.test(config.redisUrl)) {
    problems.push('REDIS_URL must start with redis:// or rediss://');
  }

  /**
   * The heartbeat/TTL relationship, checked at boot rather than on the first ping.
   *
   * `PresenceStore`'s constructor asserts it too, but that constructor runs when
   * the first socket connects. A gateway that starts, accepts connections and
   * then throws on the first heartbeat is a gateway whose health check passed.
   */
  try {
    assertPresenceConfig(config.presence);
  } catch (error) {
    if (!(error instanceof PresenceConfigError)) throw error;
    problems.push(error.message);
  }

  /**
   * A rate limit below the heartbeat rate would throttle presence itself.
   *
   * Every client sends 60/heartbeatSeconds pings a minute before it does anything
   * a person asked for. At the default 10s heartbeat that is 6, and a limit set
   * anywhere near it would start refusing drags on a board nobody is even using.
   * The factor of four leaves room for a fast drag on top.
   */
  const heartbeatsPerMinute = Math.ceil(60 / config.presence.heartbeatSeconds);
  if (config.socket.eventRateLimit < heartbeatsPerMinute * 4) {
    problems.push(
      `SOCKET_EVENT_RATE_LIMIT (${config.socket.eventRateLimit}) is too low for ` +
        `PRESENCE_HEARTBEAT_SECONDS (${config.presence.heartbeatSeconds}): a client sends ` +
        `${heartbeatsPerMinute} heartbeats a minute before it does anything a person asked for.`,
    );
  }

  /**
   * A production process with the development secret.
   *
   * The placeholder is allowlisted in .gitleaks.toml because CI and the test
   * lanes use it deliberately. That is exactly why it needs refusing here: an
   * allowlisted string is one nobody's scanner will ever complain about again.
   */
  if (config.nodeEnv === 'production' && config.authSecret.startsWith('ci-secret')) {
    problems.push(
      'AUTH_SECRET is the CI placeholder and NODE_ENV is production. ' +
        'Generate a real one: openssl rand -base64 32',
    );
  }

  if (problems.length > 0) {
    throw new ConfigError(
      `The realtime gateway cannot start:\n${problems.map((line) => `  ${line}`).join('\n')}`,
    );
  }
}
