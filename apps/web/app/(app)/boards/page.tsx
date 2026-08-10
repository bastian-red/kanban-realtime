import { boardSummarySchema } from '@kan/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { z } from 'zod';

import { NewBoardForm } from './new-board-form';
import { endpoints } from '../../../lib/endpoints';
import { authedRequest } from '../../../lib/session';

export const metadata: Metadata = { title: 'Boards' };

/**
 * Every board this person is a member of.
 *
 * `authedRequest` mints a token and parses the response against the shared
 * contract, so a field renamed in the API fails here -- naming the field --
 * rather than rendering `undefined` in a card count.
 *
 * A `<Link>` per board and no client JavaScript: the list does not move, and the
 * socket only opens on a board.
 */
export default async function BoardsPage(): Promise<JSX.Element> {
  const boards = await authedRequest(endpoints.boards, z.array(boardSummarySchema));

  return (
    <div className="page-narrow">
      <div className="page-head">
        <div className="grow">
          <h1>Boards</h1>
          <p className="lede">
            Everything you are a member of. Changes anyone makes appear on an open board without a
            reload.
          </p>
        </div>
      </div>

      <NewBoardForm />

      {boards.length === 0 ? (
        <p className="empty">You are not on any boards yet. Create one above.</p>
      ) : (
        <div className="board-grid">
          {boards.map((board) => (
            <Link key={board.id} className="board-card" href={`/boards/${board.id}`}>
              <h2>{board.name}</h2>
              <p className="board-card-meta">
                <span className="role-tag">{board.role}</span>
                <span className="num">{board.cardCount}</span>
                <span>{board.cardCount === 1 ? 'card' : 'cards'}</span>
                <span className="num">{board.memberCount}</span>
                <span>{board.memberCount === 1 ? 'member' : 'members'}</span>
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
