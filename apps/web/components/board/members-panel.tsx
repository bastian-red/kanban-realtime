'use client';

import type { BoardRole, Member } from '@kan/shared';
import { BOARD_ROLES, operationsFor } from '@kan/shared';
import { useState, useTransition } from 'react';

import {
  addMemberAction,
  removeMemberAction,
  updateMemberRoleAction,
} from '../../app/(app)/boards/[boardId]/member-actions';
import type { ActionResult } from '../../lib/action-result';
import { Notice } from '../notice';

/**
 * Who is on the board, and what each of them may do.
 *
 * The roles are rendered with the operations they grant, read from
 * `operationsFor` in `@kan/shared` -- the same matrix the API enforces and the
 * board component checks before showing a drag handle. A hand-written "editors
 * can move cards" caption here would be a third description of the permission
 * model, and the first one to drift is the one that tells somebody they can do
 * something the server then refuses.
 *
 * Two refusals belong to the API and are shown as it words them rather than being
 * pre-empted: a board has exactly one owner, and the owner cannot be demoted or
 * removed. Reimplementing those here would be a second copy of a rule whose
 * failure mode is a board with no owner -- unrecoverable, because ownership *is*
 * the membership row and there is no `owner_id` column to fall back on.
 */
export function MembersPanel({
  boardId,
  members,
  canManage,
  currentUserId,
}: {
  boardId: string;
  members: Member[];
  canManage: boolean;
  currentUserId: string;
}): JSX.Element {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (action: () => Promise<ActionResult>): void => {
    startTransition(() => {
      void action().then(setResult);
    });
  };

  return (
    <section className="panel" aria-labelledby="members-heading">
      <h2 id="members-heading">Members</h2>
      <Notice result={result} />

      <table className="table">
        <caption className="visually-hidden">People on this board and their roles</caption>
        <thead>
          <tr>
            <th scope="col">Person</th>
            <th scope="col">Role</th>
            <th scope="col">May</th>
            {canManage && <th scope="col">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.userId}>
              <th scope="row">
                {member.name}
                {member.userId === currentUserId && <span className="muted"> (you)</span>}
                <span className="activity-when">{member.email}</span>
              </th>
              <td>
                <span className="role-tag">{member.role}</span>
              </td>
              <td className="muted">{describeRole(member.role)}</td>
              {canManage && (
                <td>
                  {member.role === 'OWNER' ? (
                    // Not a disabled control: there is nothing to enable. The
                    // owner is the board's only unremovable member, and a greyed
                    // button implies a permission somebody might acquire.
                    <span className="muted">—</span>
                  ) : (
                    <div className="row">
                      <label className="visually-hidden" htmlFor={`role-${member.userId}`}>
                        Role for {member.name}
                      </label>
                      <select
                        id={`role-${member.userId}`}
                        value={member.role}
                        disabled={pending}
                        onChange={(event) =>
                          run(() =>
                            updateMemberRoleAction(
                              boardId,
                              member.userId,
                              event.target.value as BoardRole,
                            ),
                          )
                        }
                      >
                        {BOARD_ROLES.filter((role) => role !== 'OWNER').map((role) => (
                          <option key={role} value={role}>
                            {role}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="button button-small"
                        disabled={pending}
                        onClick={() => run(() => removeMemberAction(boardId, member.userId))}
                      >
                        Remove<span className="visually-hidden"> {member.name}</span>
                      </button>
                    </div>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {canManage && (
        <form
          className="row"
          action={(formData) => run(() => addMemberAction(boardId, null, formData))}
        >
          <div className="field grow" style={{ marginBottom: 0 }}>
            <label htmlFor="member-email">Add someone by email</label>
            <input id="member-email" name="email" type="email" required />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="member-role">Role</label>
            <select id="member-role" name="role" defaultValue="EDITOR">
              {BOARD_ROLES.filter((role) => role !== 'OWNER').map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="button button-primary" disabled={pending}>
            Add member
          </button>
        </form>
      )}
    </section>
  );
}

/**
 * What a role may do, in words, from the matrix rather than from prose.
 *
 * `operationsFor` is the same table `can()` answers with and the API enforces, so
 * a permission granted or withdrawn in `packages/shared/src/roles.ts` changes
 * this sentence with it. The alternative -- a hardcoded caption -- is a promise
 * the server has not made.
 */
function describeRole(role: BoardRole): string {
  const operations = operationsFor(role);
  const verbs = new Set(operations.map((operation) => operation.split('.')[1]));
  if (verbs.size === 0) return 'nothing';
  return [...verbs].sort().join(', ');
}
