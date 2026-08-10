import type { PresenceMember } from './contracts/events';

/**
 * The words that go beside the presence avatars.
 *
 * They live here rather than in `services/presence` because the **browser**
 * renders them and that package imports `ioredis`: a web bundle reaching for
 * `presenceLabel` would pull a Redis client into it. The service re-exports
 * these, so nothing on the server changed.
 *
 * One implementation, not two, for a reason more specific than tidiness. The same
 * sentence appears in three places on the board -- a chip's `title`, its
 * accessible name, and the live region that announces roster changes -- and a
 * screen-reader user hearing "Ana, moving a card" while a sighted colleague reads
 * "Ana (dragging)" is two descriptions of one fact.
 *
 * The design rule these satisfy: **presence is never colour alone.** The hue ring
 * is the third channel, after the initials and these words.
 */

/**
 * The sentence a screen reader hears, and the one printed beside the avatars.
 *
 * It is handed **everybody except the reader**. The gateway broadcasts the whole
 * roster, including the person receiving it, because a roster that varied by
 * recipient would have to be built per socket -- so the component filters, and
 * this function's whole vocabulary is about other people.
 *
 * "1 other person", not "1 person". Presence answers "who else is here", and the
 * bare count is ambiguous the moment the reader wonders whether they are in it:
 * with one colleague on the board, "1 person on this board" reads as though the
 * reader is not on it themselves.
 */
export function presenceSummary(members: readonly PresenceMember[]): string {
  if (members.length === 0) return 'Nobody else is on this board';
  const dragging = members.filter((member) => member.activity === 'dragging');
  const people = members.length === 1 ? '1 other person' : `${members.length} other people`;
  if (dragging.length === 0) return `${people} on this board`;
  const names = dragging.map((member) => member.name).join(', ');
  return `${people} on this board, ${names} moving a card`;
}

/** The accessible name of one presence chip. Never just a colour and two letters. */
export function presenceLabel(member: PresenceMember): string {
  const verb =
    member.activity === 'dragging'
      ? 'moving a card'
      : member.activity === 'editing'
        ? 'editing'
        : 'viewing';
  // Two tabs is one person. Saying so is what stops a reader wondering why the
  // roster says three people and they can only find two names.
  const tabs = member.connections > 1 ? `, ${member.connections} tabs` : '';
  return `${member.name}, ${verb}${tabs}`;
}
