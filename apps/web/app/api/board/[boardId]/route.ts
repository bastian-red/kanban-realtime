import { boardSchema } from '@kan/shared';
import { NextResponse } from 'next/server';

import { ApiError } from '../../../../lib/api';
import { endpoints } from '../../../../lib/endpoints';
import { authedRequest } from '../../../../lib/session';

/**
 * The board, for the client's resync.
 *
 * A route handler rather than a server action, because the board component calls
 * it with `fetch` from an event handler after a refused move and wants JSON back,
 * not a re-render. It exists at all because the browser cannot call `apps/api`
 * directly: the service token is minted server-side from `AUTH_SECRET`, and
 * shipping that to a client bundle would let anyone mint a token for any user.
 *
 * So this is a two-line proxy that adds authentication, and it is the only one.
 * Every other read is a server component and every other write is a socket event.
 *
 * When a move is refused -- a stale version, a column archived under the drag --
 * the client refetches rather than unwinding its optimistic placement, because
 * unwinding assumes nothing else changed while the request was in flight and on a
 * shared board something usually has.
 */
export async function GET(
  _request: Request,
  { params }: { params: { boardId: string } },
): Promise<NextResponse> {
  try {
    const board = await authedRequest(endpoints.board(params.boardId), boardSchema);
    return NextResponse.json(board, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    // The API's own status is forwarded, so a board that was deleted mid-session
    // answers 404 here too and the client can stop asking.
    const status = error instanceof ApiError ? error.status : 502;
    return NextResponse.json({ error: 'Could not load that board.' }, { status });
  }
}
