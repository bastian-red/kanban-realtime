'use client';

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { Ack, Activity, Board, Card, SessionUser } from '@kan/shared';
import { CLIENT_EVENTS, can, dueFor as computeDue, today } from '@kan/shared';
import { useCallback, useMemo, useReducer, useState } from 'react';

import { neighboursFor, reduce, type BoardEvent } from '../../lib/board-state';
import { useBoardSocket } from '../../lib/use-board-socket';
import { Notice } from '../notice';
import { PresenceBar } from '../presence-bar';
import { ActivityFeed } from './activity-feed';
import { Column, type ColumnActions } from './column';
import { Composer } from './composer';
import { MembersPanel } from './members-panel';

/**
 * The board.
 *
 * This component holds no rules. It wires four things together and every one of
 * them is testable without it:
 *
 * - `lib/board-state.ts` is a pure reducer over a `Board`, with 36 gate tests
 *   covering out-of-order events, optimistic placement and reconciliation;
 * - `lib/use-board-socket.ts` owns the connection, parses every inbound payload
 *   against the shared contract, fetches a fresh token per connection attempt,
 *   and re-joins on reconnect;
 * - `@dnd-kit` owns the drag, including the keyboard path;
 * - the server owns the order, and says so with `position`.
 *
 * The interaction worth reading closely is the drop. The card is spliced into the
 * destination **by index** immediately, so the board redraws before the round
 * trip; the server is then told which two cards to put it between, never a
 * position; and when `card.moved` comes back the column re-sorts by the position
 * the server generated. The optimistic placement and the authoritative one can
 * disagree for one round trip, and the server's is the one that survives. If the
 * ack refuses -- a stale version, a viewer's role, a column archived under the
 * drag -- the whole board is refetched rather than the move being unwound, because
 * unwinding assumes nothing else changed in the meantime and something usually
 * has.
 *
 * Every mutation on this board is a **socket event**, not a REST call, and gets
 * its result from the ack. Membership is the exception and goes over REST: it is
 * not part of a drag, and its refusals ("a board has exactly one owner") are the
 * interesting part.
 */
export function BoardClient({
  initialBoard,
  initialActivity,
  user,
  heartbeatSeconds,
}: {
  initialBoard: Board;
  initialActivity: Activity[];
  user: SessionUser;
  heartbeatSeconds: number;
}): JSX.Element {
  const [board, dispatch] = useReducer(reduce, initialBoard);
  const [activity, setActivity] = useState<Activity[]>(initialActivity);
  const [error, setError] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overListId, setOverListId] = useState<string | null>(null);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);

  // From the same matrix the API enforces. A control shown to somebody the server
  // will refuse is worse than no control: they press it and are told no.
  const canEdit = can(board.role, 'card.move');
  const canManageLists = can(board.role, 'list.create');
  const canManageMembers = can(board.role, 'board.manageMembers');

  const onEvent = useCallback((event: BoardEvent) => {
    dispatch(event);
  }, []);

  const onActivity = useCallback((entry: Activity) => {
    setActivity((current) =>
      // Idempotent by id: the actor applies its own broadcast too, and a reconnect
      // can redeliver the line that was in flight when the socket dropped.
      current.some((existing) => existing.id === entry.id) ? current : [entry, ...current],
    );
  }, []);

  const socket = useBoardSocket({
    boardId: board.id,
    heartbeatSeconds,
    onEvent,
    onActivity,
    onError: setError,
  });

  const sensors = useSensors(
    // 6px before a drag starts, so a click on the handle is a click rather than a
    // drag nobody asked for. Below about 4px a trackpad tap registers as a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // The keyboard path. Without this sensor the board is pointer-only, which is a
    // WCAG 2.1.1 failure on the app's primary interaction, not a nicety.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /**
   * The reader's today, computed once per render rather than per card.
   *
   * In the reader's own zone, from the session, not from the browser: "is this
   * card overdue?" is a question about their calendar day, and a board open on a
   * laptop in Madrid and a phone in Santiago must not disagree about which cards
   * are late.
   */
  const todayForReader = useMemo(() => today(new Date(), user.timeZone), [user.timeZone]);

  const dueFor = useCallback(
    (card: Card) => computeDue(card.dueOn, todayForReader),
    [todayForReader],
  );

  /**
   * Pull the whole board again, over REST, and apply it as a `board.state`.
   *
   * Declared before `send`, which depends on it. The two were the other way round
   * once and the dependency array had to be silenced to keep it -- a suppression
   * that would have gone stale the moment `resync` started closing over something
   * else. Ordering them correctly costs nothing and needs no comment in the array.
   */
  const resync = useCallback(async () => {
    const response = await fetch(`/api/board/${encodeURIComponent(board.id)}`, {
      cache: 'no-store',
    });
    if (!response.ok) return;
    dispatch({ type: 'board.state', board: (await response.json()) as Board });
  }, [board.id]);

  /**
   * Emit, and turn a refusal into a message.
   *
   * Every socket mutation goes through this so there is one place a `STALE` or a
   * `FORBIDDEN` becomes something a person reads. The boolean is what the inline
   * forms use to decide whether to close: a failed rename keeps what was typed.
   */
  const send = useCallback(
    async (event: string, payload: unknown): Promise<boolean> => {
      const ack: Ack<unknown> = await socket.emit(event, payload);
      if (ack.ok) {
        setError(null);
        return true;
      }
      setError(ack.error.message);
      // A stale view is the one failure the client can fix by itself, and
      // refetching is how. Anything else is a refusal the person has to act on.
      if (ack.error.code === 'STALE' || ack.error.code === 'NOT_FOUND') await resync();
      return false;
    },
    [resync, socket],
  );

  const listIdFor = useCallback(
    (id: string): string | null => {
      if (board.lists.some((list) => list.id === id)) return id;
      return board.lists.find((list) => list.cards.some((card) => card.id === id))?.id ?? null;
    },
    [board],
  );

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      setDraggingId(String(event.active.id));
      // Sent immediately rather than on the next heartbeat: a drag is shorter than
      // the heartbeat interval, so nobody would ever see "moving a card" otherwise.
      socket.setActivity('dragging');
    },
    [socket],
  );

  const onDragOver = useCallback(
    (event: DragOverEvent) => {
      setOverListId(event.over ? listIdFor(String(event.over.id)) : null);
    },
    [listIdFor],
  );

  const onDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setDraggingId(null);
      setOverListId(null);
      socket.setActivity('viewing');

      const cardId = String(event.active.id);
      const overId = event.over ? String(event.over.id) : null;
      if (!overId) return;

      const toListId = listIdFor(overId);
      if (!toListId) return;

      const target = board.lists.find((list) => list.id === toListId);
      const card = board.lists.flatMap((list) => list.cards).find((entry) => entry.id === cardId);
      if (!target || !card) return;

      // Where in the destination the card landed. Dropping on the column itself
      // rather than on a card means the end of it.
      const overIndex = target.cards.findIndex((entry) => entry.id === overId);
      const toIndex = overIndex === -1 ? target.cards.length : overIndex;

      // Neighbours are computed against the board *before* the optimistic splice,
      // because the server is being told where the card should go relative to the
      // cards that are actually there.
      const neighbours = neighboursFor(board, cardId, toListId, toIndex);

      // Through the reducer, as its own action. Wrapping it in a `board.state`
      // would re-sort the column by `position` -- which is still the old one --
      // and put the card back where it started before the browser painted.
      dispatch({ type: 'optimistic.move', move: { cardId, toListId, toIndex } });

      const ok = await send(CLIENT_EVENTS.cardMove, {
        boardId: board.id,
        cardId,
        expectedVersion: card.version,
        toListId,
        ...neighbours,
      });
      // Refetch rather than unwind. Unwinding assumes nothing else changed while
      // the request was in flight, and on a shared board something usually has.
      if (!ok) await resync();
    },
    [board, listIdFor, resync, send, socket],
  );

  const actions: ColumnActions = useMemo(
    () => ({
      addCard: (listId, title) =>
        send(CLIENT_EVENTS.cardCreate, { boardId: board.id, listId, title }),
      renameCard: async (card, title) => {
        const ok = await send(CLIENT_EVENTS.cardUpdate, {
          boardId: board.id,
          cardId: card.id,
          expectedVersion: card.version,
          title,
        });
        if (ok) setEditingCardId(null);
        return ok;
      },
      archiveCard: async (card) => {
        const ok = await send(CLIENT_EVENTS.cardArchive, {
          boardId: board.id,
          cardId: card.id,
          expectedVersion: card.version,
        });
        if (ok) setEditingCardId(null);
        return ok;
      },
      renameList: (list, name) =>
        send(CLIENT_EVENTS.listRename, { boardId: board.id, listId: list.id, name }),
      archiveList: (list) =>
        send(CLIENT_EVENTS.listArchive, { boardId: board.id, listId: list.id }),
    }),
    [board.id, send],
  );

  const feed = useMemo(() => activity.slice(0, 40), [activity]);

  return (
    <div className="board">
      <header className="board-head">
        <div className="grow">
          <h1>{board.name}</h1>
          <p className="lede">
            <span className="role-tag">{board.role}</span>{' '}
            {board.members.length === 1 ? '1 member' : `${board.members.length} members`}
          </p>
        </div>
        <PresenceBar members={socket.presence} connection={socket.state} currentUserId={user.id} />
      </header>

      {error && (
        <div className="board-head">
          <div className="grow">
            <Notice result={{ ok: false, error }} />
          </div>
          <button type="button" className="button button-small" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="board-body">
        <DndContext
          sensors={sensors}
          // `closestCorners` rather than the default rectangle intersection:
          // columns are tall and cards are short, and the default makes a card
          // dragged near a column's edge intersect nothing at all.
          collisionDetection={closestCorners}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={(event) => void onDragEnd(event)}
          onDragCancel={() => {
            setDraggingId(null);
            setOverListId(null);
            socket.setActivity('viewing');
          }}
        >
          {/* Scrolls horizontally once there are more columns than fit, so it
              needs to be focusable for the same reason each column does. */}
          <div className="board-columns" tabIndex={0} aria-label="Board columns">
            {board.lists.map((list) => (
              <Column
                key={list.id}
                list={list}
                dueFor={dueFor}
                canEdit={canEdit}
                canManage={canManageLists}
                isOver={overListId === list.id && draggingId !== null}
                editingCardId={editingCardId}
                onEditCard={setEditingCardId}
                actions={actions}
              />
            ))}

            {canManageLists && (
              <div className="column column-new">
                <Composer
                  label="Name of the new list"
                  buttonLabel="+ Add a list"
                  submitLabel="Add list"
                  maxLength={80}
                  onSubmit={(name) => send(CLIENT_EVENTS.listCreate, { boardId: board.id, name })}
                />
              </div>
            )}

            {board.lists.length === 0 && !canManageLists && (
              <p className="empty">This board has no lists yet.</p>
            )}
          </div>
        </DndContext>

        <ActivityFeed items={feed} />
      </div>

      <div className="board-foot">
        <MembersPanel
          boardId={board.id}
          members={board.members}
          canManage={canManageMembers}
          currentUserId={user.id}
        />
      </div>
    </div>
  );
}
