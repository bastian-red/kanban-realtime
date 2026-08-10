import { activityPageSchema, boardSchema } from '@kan/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { BoardClient } from '../../../../components/board/board-client';
import { ApiError } from '../../../../lib/api';
import { presenceHeartbeatSeconds } from '../../../../lib/config';
import { endpoints } from '../../../../lib/endpoints';
import { authedRequest, requireUser } from '../../../../lib/session';

export const metadata: Metadata = { title: 'Board' };

/**
 * One board: the first paint, and the credentials the live half needs.
 *
 * The board is fetched **server-side** rather than waiting for the socket's
 * `board.state`, so the first paint is a real board rather than a spinner. The
 * socket then joins and takes its own `board.state`, which supersedes this one.
 * Both come from `readBoard` in `@kan/board-store` -- one query, two transports --
 * so there is no window where the two disagree about a column's order.
 *
 * The socket's credential is **not** passed down from here. It is fetched from
 * `/api/realtime-token` on every connection attempt, because a service token
 * lives two minutes and a board is left open for hours: a token embedded in this
 * render works once and then makes every reconnect fail forever. `AUTH_SECRET`
 * still never leaves the server either way.
 */
export default async function BoardPage({
  params,
}: {
  params: { boardId: string };
}): Promise<JSX.Element> {
  const user = await requireUser();

  let board;
  try {
    board = await authedRequest(endpoints.board(params.boardId), boardSchema);
  } catch (error) {
    // The API answers 404 both for a board that does not exist and for one this
    // person is not a member of -- deliberately, so board ids cannot be used to
    // enumerate membership. Rendering Next's own 404 keeps that indistinguishable
    // here too.
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const activity = await authedRequest(
    endpoints.activity(params.boardId, { limit: 25 }),
    activityPageSchema,
  );

  return (
    <BoardClient
      initialBoard={board}
      initialActivity={activity.items}
      user={user}
      heartbeatSeconds={presenceHeartbeatSeconds()}
    />
  );
}
