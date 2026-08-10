/**
 * What every file in this lane needs before it can assert anything: a booted API,
 * a signed service token, live sockets to two gateway processes, and a way back
 * out of whatever it just wrote.
 *
 * Four decisions here shape the whole lane.
 *
 * **The app is the real `AppModule`, with nothing overridden.** A test that
 * replaces `PrismaService` with a fake is asserting on the fake. The properties
 * this lane exists to prove -- a `UNIQUE (list_id, position)` refusing a
 * duplicate, an optimistic lock rejecting a stale write, a Redis key expiring --
 * are properties of Postgres and Redis, and none of them survives being mocked.
 *
 * **The two gateways are separate OS processes, started by
 * `scripts/integration.sh`.** They are not imported and not booted in-process,
 * and that is the entire point of the cross-replica test: with one process every
 * socket shares one in-memory adapter and a broadcast arrives whether or not
 * `@socket.io/redis-adapter` is wired at all. A client on :4100 receiving a move
 * made by a client on :4101 is the only arrangement that proves the pub/sub path
 * exists.
 *
 * **Mutations go to a board this suite created.** The seeded demo boards are what
 * `scripts/dev-smoke.sh` and the E2E suite assert against, so a file that writes
 * into them changes what the next one sees. `withBoard` builds a board through
 * the real API and deletes it afterwards; the cascades take its lists, cards,
 * memberships and activity with it.
 *
 * **The token is minted here rather than fetched.** The API holds no session:
 * `apps/web` signs a short-lived HS256 token per server-side call and
 * `ServiceTokenGuard` verifies it against `AUTH_SECRET`. Minting one with
 * `@kan/shared/server` -- the same function the web app calls -- is exactly what
 * the web app does, and it means these tests do not depend on a login route to
 * exercise a card route.
 */
import 'reflect-metadata';

import { randomBytes } from 'node:crypto';

import type { Board, BoardRole, SessionUser } from '@kan/shared';
import { mintServiceToken } from '@kan/shared/server';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { io, type Socket } from 'socket.io-client';
import { expect } from 'vitest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

/** The two gateway URLs `scripts/integration.sh` starts. */
export const REALTIME_1 = process.env.REALTIME_BASE_URL ?? 'http://localhost:4100';
export const REALTIME_2 = process.env.REALTIME_BASE_URL_2 ?? 'http://localhost:4101';

export interface Harness {
  app: INestApplication;
  prisma: PrismaService;
  redis: RedisService;
  /** Supertest bound to the booted server. Add the header with `bearer()`. */
  http: TestAgent;
  close: () => Promise<void>;
}

/**
 * Boot the whole API in-process, listening on an ephemeral port.
 *
 * **`listen(0)`, not `init()`, and the difference is the concurrency proof.**
 * Handed a server that is not listening, supertest starts one per request and
 * closes it when that response ends. With twenty requests in flight against the
 * same server object -- which is exactly what the concurrent-move test fires --
 * the first response to finish closes the listener out from under the other
 * nineteen, and they fail with `read ECONNRESET`. That survived locally, where
 * the requests were fast enough to serialise, and failed on every CI run: a
 * two-core runner overlaps them properly. `taskset -c 0` reproduces it.
 *
 * Port 0 lets the kernel pick, so nothing is hardcoded and two files still cannot
 * collide.
 */
export async function boot(): Promise<Harness> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.listen(0);

  const prisma = app.get(PrismaService);
  const redis = app.get(RedisService);

  return {
    app,
    prisma,
    redis,
    http: request(app.getHttpServer()),
    close: () => app.close(),
  };
}

/** The `Authorization` header for a user, as the web app would send it. */
export function bearer(user: Pick<SessionUser, 'id' | 'email' | 'name'>): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is not set. scripts/integration.sh exports one.');
  return `Bearer ${mintServiceToken({ id: user.id, email: user.email, name: user.name }, secret)}`;
}

export interface TestUser {
  id: string;
  email: string;
  name: string;
  auth: string;
}

/** A fresh account, created straight in the database rather than through signup. */
export async function createUser(prisma: PrismaService, label: string): Promise<TestUser> {
  const suffix = randomBytes(6).toString('hex');
  const email = `${label}-${suffix}@integration.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: `${label} ${suffix}`,
      // Never used: this lane mints tokens directly. A real hash is planted
      // anyway so the row is indistinguishable from one signup would produce --
      // a column with a placeholder in it is a column somebody eventually
      // discovers is special.
      passwordHash: 'scrypt:0000:0000',
    },
  });
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    auth: bearer({ id: user.id, email: user.email, name: user.name }),
  };
}

export interface TestBoard {
  id: string;
  owner: TestUser;
  /** Lists in the order they were created. */
  lists: { id: string; name: string }[];
}

/**
 * A board with two columns, built through the real API.
 *
 * Through the API rather than through Prisma, deliberately: the positions have to
 * come from `services/ordering` the way production's do, and a test fixture that
 * planted `position: 'a0'` by hand would be asserting against keys no real board
 * ever has.
 */
export async function createBoard(
  harness: Harness,
  owner: TestUser,
  lists: readonly string[] = ['Todo', 'Doing'],
): Promise<TestBoard> {
  const board = await harness.http
    .post('/boards')
    .set('Authorization', owner.auth)
    .send({ name: `Integration ${randomBytes(4).toString('hex')}` })
    .expect(201);

  const created: { id: string; name: string }[] = [];
  for (const name of lists) {
    const response = await harness.http
      .post(`/boards/${board.body.id}/lists`)
      .set('Authorization', owner.auth)
      .send({ name })
      .expect(201);
    created.push({ id: response.body.id, name });
  }

  return { id: board.body.id, owner, lists: created };
}

/** Add somebody to a board with a role. */
export async function addMember(
  harness: Harness,
  board: TestBoard,
  member: TestUser,
  role: Exclude<BoardRole, 'OWNER'>,
): Promise<void> {
  await harness.http
    .post(`/boards/${board.id}/members`)
    .set('Authorization', board.owner.auth)
    .send({ email: member.email, role })
    .expect(201);
}

/** Every card in a list, in the order the API returns them. */
export async function readList(
  harness: Harness,
  board: TestBoard,
  user: TestUser,
  listId: string,
): Promise<Board['lists'][number]> {
  const response = await harness.http
    .get(`/boards/${board.id}`)
    .set('Authorization', user.auth)
    .expect(200);
  const list = (response.body as Board).lists.find((entry) => entry.id === listId);
  expect(list, `list ${listId} is not on the board`).toBeDefined();
  return list!;
}

/** Delete everything a test created. Cascades take the lists, cards and activity. */
export async function cleanUp(prisma: PrismaService, users: readonly TestUser[]): Promise<void> {
  // Boards first: `activities.actor_id` is `onDelete: Restrict`, so a user with
  // history cannot be deleted while their boards still exist. That constraint is
  // deliberate -- it stops a deleted account from silently blanking the feed --
  // and this is the order it forces.
  await prisma.board.deleteMany({
    where: { members: { some: { userId: { in: users.map((user) => user.id) } } } },
  });
  await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
}

// --- Sockets ----------------------------------------------------------------

export interface TestSocket {
  socket: Socket;
  /** Wait for one event, or reject with a message naming what never arrived. */
  next: <T>(event: string, timeoutMs?: number) => Promise<T>;
  /**
   * Wait for the first event that satisfies a predicate.
   *
   * Not a convenience over `next`: a correctness fix. A board is a stream, and
   * several events of the same name arrive around any action -- joining a board
   * broadcasts a roster, and so does the heartbeat that follows it. `next` takes
   * whichever lands first, so a test that connects a client and then asserts on
   * "the next presence.changed" is really asserting on the *join's* roster, which
   * is a snapshot from before the thing under test happened.
   *
   * Two presence tests were written that way and failed for exactly that reason:
   * the assertion was right, the event was the wrong one. On a timeout this
   * reports how many events it saw, so "the event never arrived" and "the
   * condition was never true" are distinguishable.
   */
  until: <T>(event: string, predicate: (payload: T) => boolean, timeoutMs?: number) => Promise<T>;
  close: () => void;
}

/**
 * Connect to one gateway and join a board.
 *
 * `transports: ['websocket']` matches the browser client. The polling fallback
 * would need sticky sessions across replicas, which is exactly the property this
 * lane is here to avoid needing.
 */
export async function connect(url: string, user: TestUser, boardId: string): Promise<TestSocket> {
  const secret = process.env.AUTH_SECRET!;
  const socket = io(url, {
    transports: ['websocket'],
    auth: { token: mintServiceToken({ id: user.id, email: user.email, name: user.name }, secret) },
    reconnection: false,
  });

  const handle: TestSocket = {
    socket,
    next: <T>(event: string, timeoutMs = 10_000): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.off(event, onEvent);
          reject(new Error(`no ${event} within ${timeoutMs}ms on ${url}`));
        }, timeoutMs);
        const onEvent = (payload: T): void => {
          clearTimeout(timer);
          socket.off(event, onEvent);
          resolve(payload);
        };
        socket.on(event, onEvent);
      }),
    until: <T>(event: string, predicate: (payload: T) => boolean, timeoutMs = 10_000): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        let seen = 0;
        const timer = setTimeout(() => {
          socket.off(event, onEvent);
          reject(
            new Error(
              `no ${event} matching the predicate within ${timeoutMs}ms on ${url} ` +
                `(${seen} ${event} event${seen === 1 ? '' : 's'} seen)`,
            ),
          );
        }, timeoutMs);
        const onEvent = (payload: T): void => {
          seen += 1;
          if (!predicate(payload)) return;
          clearTimeout(timer);
          socket.off(event, onEvent);
          resolve(payload);
        };
        socket.on(event, onEvent);
      }),
    close: () => {
      socket.removeAllListeners();
      socket.close();
    },
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no connection to ${url} within 10s`)), 10_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error: Error) => {
      clearTimeout(timer);
      reject(new Error(`handshake refused by ${url}: ${error.message}`));
    });
  });

  const ack = await emit(socket, 'board.join', { boardId });
  expect(ack.ok, `board.join on ${url} was refused: ${JSON.stringify(ack)}`).toBe(true);

  return handle;
}

/** Emit and wait for the typed ack, with a bounded wait. */
export function emit(
  socket: Socket,
  event: string,
  payload: unknown,
  timeoutMs = 10_000,
): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${event} was never acknowledged within ${timeoutMs}ms`)),
      timeoutMs,
    );
    socket.emit(event, payload, (ack: { ok: boolean }) => {
      clearTimeout(timer);
      resolve(ack as { ok: boolean; data?: unknown });
    });
  });
}
