/**
 * How a REST write reaches a socket.
 *
 * The API runs no Socket.io server. It does not need one: `@socket.io/redis-emitter`
 * publishes onto the **same Redis channel** `@socket.io/redis-adapter` already
 * subscribes to in every gateway replica, so `emitter.to(room).emit(...)` is
 * delivered by whichever replicas hold sockets in that room. One shared channel,
 * no HTTP hop from the API to the gateway, and no "which replica is that person
 * on" question to answer.
 *
 * Why this exists at all: **the same write has two front doors.** Dragging a card
 * goes over the socket, and the gateway broadcasts the result itself. Renaming a
 * board, adding a member or moving a card from a client with no socket open goes
 * over REST -- and without this file that write lands in Postgres and nobody
 * looking at the board sees it until they reload. The failure is invisible from
 * the API's side: the response is a 200 with the correct body.
 *
 * Three properties, each load-bearing:
 *
 * **It shares `RedisService`'s connection.** The emitter only publishes, so a
 * second socket would buy nothing and cost one more thing to close on shutdown.
 *
 * **It never throws into the caller.** `RedisService` runs with
 * `enableOfflineQueue: false`, so a publish while Redis is down rejects
 * immediately rather than hanging. The row is already committed by the time we
 * get here; turning that into a 500 would tell the user to retry a write that
 * succeeded, and the retry would do it twice. `BoardBroadcast` contains the
 * failure and hands it here to be logged.
 *
 * **The event names and payloads come from `BoardBroadcast`,** which the gateway
 * also uses. A REST move and a socket move are the same write and must produce
 * the same event in the same room; two implementations of that mapping disagree
 * eventually, and the way they fail is a client that silently stops updating.
 */
import { BoardBroadcast } from '@kan/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';

import { RedisService } from '../redis/redis.service';

@Injectable()
export class RealtimeEmitter extends BoardBroadcast {
  private static readonly logger = new Logger(RealtimeEmitter.name);

  constructor(@Inject(RedisService) redis: RedisService) {
    super(new Emitter(redis.client), {
      onFailure: (event, boardId, error) => {
        // `warn`, not `error`: the write succeeded and the product is degraded,
        // not broken. Clients resync on their next reconnect, which is the same
        // path a backgrounded tab already takes.
        RealtimeEmitter.logger.warn(
          `Could not broadcast ${event} for board ${boardId}: ${describe(error)}. ` +
            'The write is committed; clients will see it on their next resync.',
        );
      },
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
