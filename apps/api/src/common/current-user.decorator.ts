import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { REQUEST_USER, type TokenUser } from './service-token.guard';

/**
 * The verified caller, from the token.
 *
 * Every handler in this API takes the user id from here and from nowhere else.
 * There is no `userId` path parameter and no `userId` field in any request body,
 * because either one is a value the client chooses, and a client that chooses
 * whose board it is reading is not a membership boundary.
 *
 * `ServiceTokenGuard` runs before this decorator on every non-public route and
 * throws when there is no valid token, so the value is present by construction.
 * The throw below covers the one way that stops being true: someone adding
 * `@Public()` to a handler that also reads the user.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TokenUser => {
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    const user = request[REQUEST_USER] as TokenUser | undefined;
    if (!user) {
      throw new Error(
        'No authenticated user on the request. A route that reads @CurrentUser() cannot also be @Public().',
      );
    }
    return user;
  },
);
