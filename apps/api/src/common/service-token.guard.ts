/**
 * The API holds no session.
 *
 * The web app owns the browser session (Auth.js) and mints a short-lived HS256
 * token per server-side call, signed with `AUTH_SECRET`, which all three
 * processes already share. This guard verifies that token and nothing else: no
 * cookie, no database round trip, no session table. That is what makes the API
 * horizontally scalable without a shared session store, and it is why every
 * handler takes the user id from the token rather than from a parameter.
 *
 * The verification itself is `@kan/shared/server`, not code in this file. It used
 * to live here, which meant the *minting* side in the web app and the *verifying*
 * side here were two descriptions of one token format, and the gateway would have
 * been a third. A claim added to one and not read by the others is silent: the
 * token still verifies and the field is simply absent downstream. One module now
 * says what a token contains, and this file's whole job is turning a failure into
 * the framework's 401.
 */
import { verifyServiceToken, type TokenUser } from '@kan/shared/server';
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { API_CONFIG } from '../config/config.module';
import type { ApiConfig } from '../config/config';
import { IS_PUBLIC_KEY } from './public.decorator';

export type { TokenUser };

/** Where the verified caller is parked on the request object. */
export const REQUEST_USER = 'kanUser';

interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  [REQUEST_USER]?: TokenUser;
}

/**
 * One message for every failure.
 *
 * `verifyServiceToken` reports *why* it refused, and that reason is for this
 * server's logs only. Distinguishing "expired" from "bad signature" in the
 * response tells an attacker which half of the token to keep working on.
 */
const REFUSED = 'Invalid or expired service token';

@Injectable()
export class ServiceTokenGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request[REQUEST_USER] = authenticate(request.headers.authorization, this.config.authSecret);
    return true;
  }
}

/**
 * A verified caller, or a 401.
 *
 * Exported so the token path has a test that does not have to build a Nest
 * execution context to reach it.
 */
export function authenticate(header: string | string[] | undefined, secret: string): TokenUser {
  const token = readBearerOrThrow(header);
  const result = verifyServiceToken(token, secret);
  if (!result.ok) throw new UnauthorizedException(REFUSED);
  return result.user;
}

function readBearerOrThrow(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') throw new UnauthorizedException('Missing bearer token');
  const match = /^bearer\s+(\S+)$/i.exec(value.trim());
  if (!match?.[1]) throw new UnauthorizedException('Malformed Authorization header');
  return match[1];
}
