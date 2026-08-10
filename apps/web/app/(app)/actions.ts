'use server';

import { boardSummarySchema, createBoardSchema, renameBoardSchema } from '@kan/shared';
import { revalidatePath } from 'next/cache';

import { failed, ok, runAction, type ActionResult } from '../../lib/action-result';
import { endpoints } from '../../lib/endpoints';
import { authedRequest } from '../../lib/session';

/**
 * Board-level writes.
 *
 * These go over REST rather than over the socket, and that is not an oversight:
 * they happen on the boards list, where no socket is open. Renaming is still
 * broadcast -- `apps/api` publishes `board.renamed` through the Redis emitter --
 * so anybody who has the board open sees the new title without reloading. That is
 * the one broadcast in the whole app that only ever originates in the API.
 *
 * Card and list writes are the opposite: they are socket events, because the
 * person making them already has a connection open and a REST round trip would
 * cost a second hop on the interaction the product is judged on.
 */

export async function createBoardAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = createBoardSchema.safeParse({ name: formData.get('name') });
  if (!parsed.success) return failed('A board needs a name of at least one character.');

  return runAction(`Created ${parsed.data.name}.`, async () => {
    await authedRequest(endpoints.boards, boardSummarySchema, {
      method: 'POST',
      json: parsed.data,
    });
    // The list is a server component, so the new board only appears if the route
    // is re-rendered. Without this the action succeeds and the page does not
    // change, which reads as a failure.
    revalidatePath('/boards');
  });
}

export async function renameBoardAction(
  boardId: string,
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = renameBoardSchema.safeParse({ name: formData.get('name') });
  if (!parsed.success) return failed('A board needs a name of at least one character.');

  const result = await runAction(`Renamed to ${parsed.data.name}.`, async () => {
    await authedRequest(endpoints.board(boardId), boardSummarySchema, {
      method: 'PATCH',
      json: parsed.data,
    });
    revalidatePath('/boards');
    revalidatePath(`/boards/${boardId}`);
  });

  return result.ok ? ok(`Renamed to ${parsed.data.name}.`) : result;
}
