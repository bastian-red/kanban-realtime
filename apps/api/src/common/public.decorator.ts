import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'kan:public';

/**
 * Opt a route out of `ServiceTokenGuard`.
 *
 * The guard is registered globally, so the default for a new route is
 * "authenticated". That direction is the whole point: a route that forgets the
 * decorator is closed, not open. Exactly two routes carry this -- `GET /health`,
 * which a load balancer calls with no credentials, and `POST /auth/signup` and
 * `POST /auth/login`, which are how a caller gets a token in the first place.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
