'use server';

import { addMemberSchema, memberSchema, type BoardRole } from '@kan/shared';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { failed, runAction, type ActionResult } from '../../../../lib/action-result';
import { endpoints } from '../../../../lib/endpoints';
import { authedRequest } from '../../../../lib/session';

/**
 * Membership, over REST rather than over the socket.
 *
 * Cards and lists are socket events because the person changing them already has
 * a connection open and a REST round trip would cost a second hop on the
 * interaction the product is judged on. Membership is the opposite: it happens
 * once, it is not part of a drag, and it is the operation whose *refusals* are
 * the interesting part -- an editor trying to add a member must be told why, and
 * an HTTP status carries that better than a socket ack nobody is watching for.
 *
 * The API still broadcasts `member.changed` afterwards through the Redis emitter,
 * so anybody with the board open sees the roster change without reloading. That
 * is the same path a board rename takes.
 *
 * Two refusals are the API's and are surfaced verbatim rather than pre-empted
 * here: a board has exactly one owner, so adding a second is refused, and the
 * owner cannot be demoted or removed. Duplicating those rules in the browser
 * would be a second implementation of them, and the first one to drift is the one
 * that lets a board end up with no owner at all -- which is unrecoverable,
 * because ownership *is* the membership row.
 */

const roleSchema = z.enum(['OWNER', 'EDITOR', 'VIEWER']);

export async function addMemberAction(
  boardId: string,
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = addMemberSchema.safeParse({
    email: formData.get('email'),
    role: formData.get('role'),
  });
  if (!parsed.success) return failed('Enter the email address of an existing account, and a role.');

  return runAction(`${parsed.data.email} can now see this board.`, async () => {
    await authedRequest(endpoints.boardMembers(boardId), z.array(memberSchema), {
      method: 'POST',
      json: parsed.data,
    });
    revalidatePath(`/boards/${boardId}`);
  });
}

export async function updateMemberRoleAction(
  boardId: string,
  userId: string,
  role: BoardRole,
): Promise<ActionResult> {
  const parsed = roleSchema.safeParse(role);
  if (!parsed.success) return failed('That is not a role.');

  return runAction('Role changed.', async () => {
    await authedRequest(endpoints.boardMember(boardId, userId), z.array(memberSchema), {
      method: 'PATCH',
      json: { role: parsed.data },
    });
    revalidatePath(`/boards/${boardId}`);
  });
}

export async function removeMemberAction(boardId: string, userId: string): Promise<ActionResult> {
  return runAction('Removed from the board.', async () => {
    await authedRequest(endpoints.boardMember(boardId, userId), z.array(memberSchema), {
      method: 'DELETE',
    });
    revalidatePath(`/boards/${boardId}`);
  });
}
