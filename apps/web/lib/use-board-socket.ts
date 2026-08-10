'use client';

import type {
  Ack,
  Activity,
  Board,
  Card,
  CardMoved,
  ListHeader,
  Member,
  PresenceMember,
} from '@kan/shared';
import {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  activityAppendedSchema,
  boardRenamedSchema,
  cardArchivedSchema,
  cardCreatedSchema,
  cardMovedSchema,
  cardUpdatedSchema,
  listArchivedSchema,
  listCreatedSchema,
  listMovedSchema,
  listUpdatedSchema,
  memberChangedSchema,
  presenceChangedSchema,
  boardSchema,
  type PresenceActivity,
} from '@kan/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

import { PUBLIC_REALTIME_URL } from './config';
import type { BoardEvent } from './board-state';

/**
 * The board's live connection.
 *
 * Everything the socket does for the board is here, and the board component sees
 * three things: a connection state, a `dispatch`-shaped stream of typed events,
 * and an `emit` that returns the server's ack. That split is what keeps the
 * component free of protocol handling and lets `board-state.ts` stay a pure
 * function anybody can test.
 *
 * Three decisions worth stating.
 *
 * **Every inbound payload is parsed, not cast.** The gateway and this file import
 * the same schemas from `@kan/shared`, so a payload that has drifted throws here
 * -- at the boundary, naming the field -- rather than rendering `undefined` in a
 * card title. A socket message is untrusted input like any other; it just happens
 * to come from code in the same repository.
 *
 * **The token is fetched per connection attempt, not held.** `auth` is a callback
 * rather than a value, and Socket.io calls it before every connect *and every
 * reconnect*. That is not tidiness: a service token lives two minutes, so a token
 * handed down as a prop works for the first connect and then quietly stops -- a
 * board left open over lunch reconnects with a credential that expired forty
 * minutes ago, the handshake is refused, and the client retries with the same
 * dead token forever. `/api/realtime-token` exchanges the session cookie for a
 * live one; `AUTH_SECRET` never leaves the server.
 *
 * **A reconnect re-joins and takes a fresh `board.state`.** Socket.io reconnects
 * on its own but rooms are per-connection and do not survive one, so without the
 * re-join the board would look connected and receive nothing. Taking the whole
 * board again rather than replaying missed events is deliberate: there is no
 * event log to replay from, and a board is small.
 */

export type ConnectionState = 'connecting' | 'live' | 'down';

export interface BoardSocket {
  state: ConnectionState;
  presence: PresenceMember[];
  /** Emit a client event and wait for the typed ack. */
  emit: <T>(event: string, payload: unknown) => Promise<Ack<T>>;
  /** Tell the board what this person is doing, for the presence roster. */
  setActivity: (activity: PresenceActivity) => void;
}

export interface UseBoardSocketOptions {
  boardId: string;
  heartbeatSeconds: number;
  /** Applied to the board in order. See `lib/board-state.ts`. */
  onEvent: (event: BoardEvent) => void;
  /**
   * One activity line, as it is written.
   *
   * Separate from `onEvent` because the feed is a log beside the board rather
   * than part of it: routing it through the board reducer would make every card
   * movement re-render a list of forty rows that did not change.
   */
  onActivity: (activity: Activity) => void;
  onError: (message: string) => void;
}

export function useBoardSocket(options: UseBoardSocketOptions): BoardSocket {
  const { boardId, heartbeatSeconds, onEvent, onActivity, onError } = options;
  const [state, setState] = useState<ConnectionState>('connecting');
  const [presence, setPresence] = useState<PresenceMember[]>([]);
  const socketRef = useRef<Socket | null>(null);
  /**
   * What to report on the next heartbeat.
   *
   * A ref rather than state: the heartbeat interval closes over it, and putting
   * it in state would tear the interval down and rebuild it on every drag.
   */
  const activityRef = useRef<PresenceActivity>('viewing');

  // The callbacks are held in refs so the effect below depends on the board id
  // and the token alone. Without this, a parent re-render would produce new
  // function identities, the effect would re-run, and the socket would be torn
  // down and rebuilt on every keystroke in a card title.
  const onEventRef = useRef(onEvent);
  const onActivityRef = useRef(onActivity);
  const onErrorRef = useRef(onError);
  onEventRef.current = onEvent;
  onActivityRef.current = onActivity;
  onErrorRef.current = onError;

  useEffect(() => {
    const socket = io(PUBLIC_REALTIME_URL, {
      /**
       * Called before every connection attempt, including reconnects.
       *
       * A failure here hands the gateway an empty token, which it refuses with
       * the same message as any other bad one -- the right outcome, because the
       * cause is a session that has ended and the fix is signing in again.
       */
      auth: (cb: (data: { token: string }) => void) => {
        void fetch('/api/realtime-token', { cache: 'no-store' })
          .then(async (response) => {
            if (!response.ok) throw new Error(String(response.status));
            const body = (await response.json()) as { token?: string };
            cb({ token: body.token ?? '' });
          })
          .catch(() => cb({ token: '' }));
      },
      // WebSocket only. The polling fallback would work, but it makes a
      // horizontally scaled gateway need sticky sessions: two polling requests
      // from one client can land on two replicas, and the handshake state lives
      // on one of them. A single WebSocket connection has no such problem, which
      // is the entire reason this app can run several replicas behind nothing
      // cleverer than a round robin.
      transports: ['websocket'],
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
    });
    socketRef.current = socket;

    /** Parse, then hand on. A drifted payload fails here, naming the field. */
    const on = <T>(
      event: string,
      schema: { parse: (value: unknown) => T },
      handle: (payload: T) => void,
    ): void => {
      socket.on(event, (raw: unknown) => {
        try {
          handle(schema.parse(raw));
        } catch (error) {
          console.error(`[socket] ${event} did not match its contract`, error);
          onErrorRef.current('The board received an update it could not read. Reload the page.');
        }
      });
    };

    const join = (): void => {
      socket.emit(CLIENT_EVENTS.boardJoin, { boardId }, (ack: Ack<unknown>) => {
        if (!ack.ok) {
          onErrorRef.current(ack.error.message);
          return;
        }
        setState('live');
      });
    };

    socket.on('connect', join);
    socket.on('disconnect', () => setState('down'));
    socket.on('connect_error', (error: Error) => {
      setState('down');
      onErrorRef.current(error.message);
    });

    on(SERVER_EVENTS.boardState, boardSchema, (board: Board) =>
      onEventRef.current({ type: 'board.state', board }),
    );
    on(SERVER_EVENTS.boardRenamed, boardRenamedSchema, (payload) =>
      onEventRef.current({ type: 'board.renamed', name: payload.name }),
    );
    on(SERVER_EVENTS.memberChanged, memberChangedSchema, (payload) =>
      onEventRef.current({ type: 'member.changed', members: payload.members as Member[] }),
    );
    on(SERVER_EVENTS.listCreated, listCreatedSchema, (payload) =>
      onEventRef.current({ type: 'list.created', list: payload.list as ListHeader }),
    );
    on(SERVER_EVENTS.listUpdated, listUpdatedSchema, (payload) =>
      onEventRef.current({ type: 'list.updated', list: payload.list as ListHeader }),
    );
    on(SERVER_EVENTS.listMoved, listMovedSchema, (payload) =>
      onEventRef.current({
        type: 'list.moved',
        listId: payload.listId,
        position: payload.position,
      }),
    );
    on(SERVER_EVENTS.listArchived, listArchivedSchema, (payload) =>
      onEventRef.current({ type: 'list.archived', listId: payload.listId }),
    );
    on(SERVER_EVENTS.cardCreated, cardCreatedSchema, (payload) =>
      onEventRef.current({ type: 'card.created', card: payload.card as Card }),
    );
    on(SERVER_EVENTS.cardUpdated, cardUpdatedSchema, (payload) =>
      onEventRef.current({ type: 'card.updated', card: payload.card as Card }),
    );
    on(SERVER_EVENTS.cardMoved, cardMovedSchema, (payload) =>
      onEventRef.current({ type: 'card.moved', move: payload as CardMoved }),
    );
    on(SERVER_EVENTS.cardArchived, cardArchivedSchema, (payload) =>
      onEventRef.current({ type: 'card.archived', cardId: payload.cardId, listId: payload.listId }),
    );
    on(SERVER_EVENTS.activityAppended, activityAppendedSchema, (payload) =>
      onActivityRef.current(payload.activity as Activity),
    );
    on(SERVER_EVENTS.presenceChanged, presenceChangedSchema, (payload) => {
      // Ignore a roster for a board this component is not showing. One socket can
      // be in several boards, and a stale tab's roster would replace this one's.
      if (payload.boardId === boardId) setPresence(payload.members as PresenceMember[]);
    });

    socket.on(SERVER_EVENTS.error, (payload: { message?: string }) => {
      onErrorRef.current(payload?.message ?? 'The board refused that change.');
    });

    const heartbeat = setInterval(() => {
      if (!socket.connected) return;
      socket.emit(CLIENT_EVENTS.presencePing, { boardId, activity: activityRef.current });
    }, heartbeatSeconds * 1_000);

    return () => {
      clearInterval(heartbeat);
      // `removeAllListeners` before `close`: without it a React strict-mode
      // double-mount leaves the first socket's handlers attached to a closed
      // connection, and every event is applied to the board twice.
      socket.removeAllListeners();
      socket.close();
      socketRef.current = null;
    };
  }, [boardId, heartbeatSeconds]);

  const emit = useCallback(<T>(event: string, payload: unknown): Promise<Ack<T>> => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      return Promise.resolve({
        ok: false,
        error: { code: 'INTERNAL', message: 'Not connected to the board.', event },
      });
    }
    return new Promise<Ack<T>>((resolve) => {
      socket.emit(event, payload, (ack: Ack<T>) => resolve(ack));
    });
  }, []);

  const setActivity = useCallback(
    (activity: PresenceActivity) => {
      activityRef.current = activity;
      // Sent immediately as well as on the next heartbeat. A drag lasts less than
      // one heartbeat interval, so waiting would mean nobody ever sees "moving a
      // card" -- which is the one presence state worth showing.
      socketRef.current?.emit(CLIENT_EVENTS.presencePing, { boardId, activity });
    },
    [boardId],
  );

  return useMemo(
    () => ({ state, presence, emit, setActivity }),
    [state, presence, emit, setActivity],
  );
}
