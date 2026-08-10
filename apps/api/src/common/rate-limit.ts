/**
 * Two rate-limit buckets, and the guard that refuses to take the API down with
 * the limiter.
 *
 * `RATE_LIMIT_GLOBAL` and `RATE_LIMIT_AUTH` are two different budgets because the
 * requests cost two different amounts. An ordinary board read is a handful of
 * indexed queries; a login runs scrypt, which is memory-hard on purpose and is
 * therefore also a denial-of-service lever pointed at us. One number cannot be
 * right for both, and the tight one has to be the login.
 *
 * `@nestjs/throttler` applies **every** configured throttler to every route, so
 * naming two of them and stopping there would charge each login against the auth
 * budget *and* the global one. The decorators below are the opt-out that makes
 * each controller sit in exactly one bucket, and they exist as named decorators
 * rather than as inline `SkipThrottle` calls so that "which bucket is this route
 * in" is one word at the top of the controller instead of a set difference the
 * reader has to compute.
 *
 * Note what is deliberately absent: a bucket for card moves. A drag is a socket
 * event, not an HTTP request, and it is metered per socket by
 * SOCKET_EVENT_RATE_LIMIT in apps/realtime. Metering the same action twice, in
 * two places, with two numbers that can disagree, is how a board becomes
 * unusable for the one person dragging fastest.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  SkipThrottle,
  ThrottlerException,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';

export const RATE_BUCKET_GLOBAL = 'global';
export const RATE_BUCKET_AUTH = 'auth';

/** The default for a data route: the global budget only. */
export const OrdinaryRate = (): MethodDecorator & ClassDecorator =>
  SkipThrottle({ [RATE_BUCKET_AUTH]: true });

/** Signup and sign-in verification. The auth budget is far tighter, so it binds. */
export const AuthRate = (): MethodDecorator & ClassDecorator => SkipThrottle({});

/**
 * No budget at all.
 *
 * Only `/health`, which is polled on a fixed interval by something that is not a
 * user. Rate-limiting a health check means the monitor's own traffic eventually
 * reports the service as down, which is a self-inflicted incident.
 */
export const NoRate = (): MethodDecorator & ClassDecorator =>
  SkipThrottle({ [RATE_BUCKET_GLOBAL]: true, [RATE_BUCKET_AUTH]: true });

/**
 * The throttler, failing open when its storage is unreachable.
 *
 * The counters live in Redis. Without this subclass, a Redis outage makes
 * `increment` reject, the guard propagates it, and **every route in the API**
 * answers 500, including the board read that has nothing to do with Redis at all. The limiter would become the single point of failure it exists to
 * protect against.
 *
 * So a storage failure allows the request and logs it. That is the standard
 * trade: for the duration of the outage the API is unmetered, which is a risk;
 * fail-closed would mean the API is *down*, which is a certainty. A
 * `ThrottlerException` is a real verdict rather than a transport failure and is
 * re-thrown untouched.
 *
 * The constructor is spelled out with explicit injection tokens on purpose. The
 * test lane transpiles with esbuild, which implements `experimentalDecorators`
 * but not `emitDecoratorMetadata`, so an implicit constructor parameter has no
 * `design:paramtypes` entry and Nest injects `undefined` -- at request time, not
 * at boot. Every constructor in this API is written this way.
 */
@Injectable()
export class ResilientThrottlerGuard extends ThrottlerGuard {
  private readonly failOpenLogger = new Logger(ResilientThrottlerGuard.name);

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    @Inject(Reflector) reflector: Reflector,
  ) {
    super(options, storageService, reflector);
  }

  protected override async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    try {
      return await super.handleRequest(requestProps);
    } catch (error) {
      if (error instanceof ThrottlerException) throw error;
      this.failOpenLogger.warn(
        `Rate-limit storage is unavailable, allowing the request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return true;
    }
  }
}
