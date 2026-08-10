/**
 * Signup and login, and nothing else.
 *
 * The API holds **no session**. The web app owns the browser session and mints a
 * short-lived HS256 service token per server-side call, which `ServiceTokenGuard`
 * verifies; the realtime gateway verifies the same signature on its handshake.
 * So these two routes do not issue a token, set a cookie or write a session row:
 * they answer "is this person who they say they are, and what is on their
 * profile". Everything after that is the web app's problem, which is what lets
 * both server processes scale horizontally with no shared session store.
 */
import type { Credentials, SessionUser, Signup } from '@kan/shared';
import { hashPassword, verifyPassword } from '@kan/shared/server';
import { isUniqueViolation, USER_EMAIL_UNIQUE, type User } from '@kan/db';
import { keysBetween } from '@kan/ordering';
import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

/**
 * A real scrypt hash of a password nobody has, used only to burn the same CPU on
 * a missing account as on a wrong password.
 *
 * Without it, `login` returns in microseconds for an address that does not exist
 * and in ~100ms for one that does, because only the second path runs scrypt.
 * That difference is measurable over the network and turns the login route into
 * a user-enumeration oracle: an attacker learns which of a leaked address list
 * has an account here before trying a single password.
 *
 * Computed once at module load rather than written as a literal, so it stays a
 * valid hash if the format in `@kan/shared/server` ever changes, and so gitleaks
 * has no credential-shaped string to find.
 */
const DUMMY_HASH = hashPassword('no user with this address exists');

/**
 * The three columns a new board opens with.
 *
 * A Kanban board with no lists has nowhere to put a card, so a signup that
 * planted only a `User` row would drop the new person on a board they cannot
 * use and cannot fix without knowing the product. These names are the ones the
 * seed uses too, so the empty account and the demo account read the same.
 */
export const STARTER_LIST_NAMES = ['Backlog', 'In progress', 'Done'] as const;

/** The board a new account starts with. */
export const STARTER_BOARD_NAME = 'My first board';

@Injectable()
export class AuthService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Create the account and its starter board, in one transaction.
   *
   * All of it or none of it. A `User` row that committed while the board insert
   * failed is an account that owns nothing and that signup can never be retried
   * for, because the email is now taken. There is no screen anywhere in this app
   * that repairs that state, so it must not be reachable.
   */
  async signup(input: Signup): Promise<SessionUser> {
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email: input.email.toLowerCase(),
            passwordHash: hashPassword(input.password),
            name: input.name,
            // Left to the column default when the caller says nothing, rather
            // than defaulted here: two defaults for one value is two places to
            // change it and one of them will be missed.
            ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
          },
        });

        // Fractional keys from the same generator the drag path uses, not
        // '1'/'2'/'3'. A hand-written position has to satisfy
        // `cards_position_format` and has to sort correctly against every key
        // generated afterwards; borrowing the generator is how those two stay
        // true without this file knowing the encoding.
        const positions = keysBetween(null, null, STARTER_LIST_NAMES.length);

        await tx.board.create({
          data: {
            name: STARTER_BOARD_NAME,
            members: { create: { userId: created.id, role: 'OWNER' } },
            lists: {
              create: STARTER_LIST_NAMES.map((name, index) => ({
                name,
                position: positions[index] as string,
              })),
            },
          },
        });

        return created;
      });

      return sessionUserOf(user);
    } catch (error) {
      // The email index is the only unique constraint this transaction can hit,
      // and "that address is taken" is a 409 the caller can act on rather than
      // the 500 an unhandled Prisma error would become. Named rather than bare,
      // so a future constraint on this path does not silently report itself as a
      // duplicate email.
      if (isUniqueViolation(error, USER_EMAIL_UNIQUE)) {
        throw new ConflictException('An account with that email address already exists.');
      }
      throw error;
    }
  }

  /**
   * Verify a password. One message for every failure.
   *
   * "No such user" and "wrong password" are the same 401 with the same sentence,
   * because telling them apart is the enumeration oracle again, this time in
   * words instead of in timing.
   */
  async login(input: Credentials): Promise<SessionUser> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    const matches = verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);

    if (!user || !matches) {
      throw new UnauthorizedException('That email address and password do not match an account.');
    }

    return sessionUserOf(user);
  }

  /** The profile behind a service token, for the web app's session refresh. */
  async profile(userId: string): Promise<SessionUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('That account no longer exists.');
    return sessionUserOf(user);
  }
}

/**
 * The row, reduced to exactly what `sessionUserSchema` publishes. Never the hash.
 *
 * Spelled out field by field rather than spread. A spread of the Prisma row would
 * put `passwordHash` in every signup and login response the day somebody adds a
 * field, and the type would still compile because `SessionUser` does not forbid
 * extra keys at runtime.
 */
export function sessionUserOf(user: Pick<User, 'id' | 'email' | 'name' | 'timeZone'>): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    timeZone: user.timeZone,
  };
}
