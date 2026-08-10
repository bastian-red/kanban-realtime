'use client';

import { presenceLabel, presenceSummary, type PresenceMember } from '@kan/shared';

import type { ConnectionState } from '../lib/use-board-socket';

/**
 * Who is on the board, and whether this browser is still hearing about it.
 *
 * The design rule this component exists to satisfy: **presence is never colour
 * alone.** Each chip carries three channels -- the person's initials as text, a
 * hue ring, and an activity word in its accessible name -- and the summary line
 * beside them says the same thing in a sentence. A row of coloured dots is one
 * channel, and it is the one a deuteranopic reader does not have.
 *
 * `presenceLabel` and `presenceSummary` come from `@kan/shared` rather than being
 * written here, so the wording cannot drift between the chip's tooltip, its
 * accessible name and the live region. The chips themselves are `aria-hidden`
 * and the sentence carries the whole roster: eight avatars announced one by one
 * is noise, and the sentence is what a screen-reader user actually wants.
 */
export function PresenceBar({
  members,
  connection,
  currentUserId,
}: {
  members: PresenceMember[];
  connection: ConnectionState;
  /** The reader. Excluded from the roster: presence answers "who ELSE is here". */
  currentUserId: string;
}): JSX.Element {
  /**
   * Everybody but the reader.
   *
   * The gateway broadcasts the whole roster, including the person receiving it,
   * because a roster that varied by recipient would have to be built per socket.
   * Filtering here is what makes the sentence true: `presenceSummary` says
   * "Nobody else is on this board", and with yourself in the list it never could.
   */
  const others = members.filter((member) => member.userId !== currentUserId);

  return (
    <div className="presence">
      <ul className="presence-list" aria-hidden="true">
        {others.map((member) => (
          <li key={member.userId}>
            <span
              className={`presence-chip hue-${member.colorSlot}${
                member.activity === 'dragging' ? ' presence-dragging' : ''
              }`}
              title={presenceLabel(member)}
            >
              {member.initials}
            </span>
          </li>
        ))}
      </ul>

      {/*
        The roster as a sentence, announced when it changes. `polite` rather than
        `assertive`: somebody arriving on a board must not interrupt whatever the
        reader is in the middle of.
      */}
      <p className="presence-summary" aria-live="polite">
        {presenceSummary(others)}
      </p>

      <ConnectionChip state={connection} />
    </div>
  );
}

/**
 * Whether this browser is still receiving updates.
 *
 * Worth its own indicator because the failure is otherwise invisible: a
 * disconnected board looks exactly like a board nobody else is touching. The word
 * is the signal and the dot is decoration beside it -- `--ok` and `--wip-over`
 * are 1.12:1 apart in greyscale.
 */
function ConnectionChip({ state }: { state: ConnectionState }): JSX.Element {
  const label = state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting' : 'Reconnecting';
  const className =
    state === 'live'
      ? 'connection connection-live'
      : state === 'down'
        ? 'connection connection-down'
        : 'connection';

  return (
    <span className={className} aria-live="polite">
      <span className="connection-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
