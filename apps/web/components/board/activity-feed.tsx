'use client';

import type { Activity } from '@kan/shared';

/**
 * What has happened on this board, newest first.
 *
 * The feed is append-only and never re-renders history: `subject` was
 * denormalised at write time, so "Ana moved **Fix login** to Doing" keeps saying
 * "Fix login" after the card is renamed or archived. Rendering the current title
 * instead would quietly rewrite the past every time somebody edits a card.
 *
 * The list is a live region so a screen-reader user is told what colleagues are
 * doing without having to go looking. `polite` because a colleague's drag must
 * not interrupt whatever the reader is doing, and the region is capped to the
 * newest few entries -- a live region containing forty rows re-announces far more
 * than the one line that changed.
 */
export function ActivityFeed({ items }: { items: Activity[] }): JSX.Element {
  return (
    // `tabIndex={0}` for the same reason the columns have it: the feed scrolls
    // once there are more than a few entries, and a scrollable region with no way
    // to focus it cannot be scrolled by keyboard -- WCAG 2.1.1, and axe's
    // `scrollable-region-focusable`. It already has an accessible name from the
    // heading, which is the other half of what the rule wants.
    <aside className="activity" aria-labelledby="activity-heading" tabIndex={0}>
      <h2 id="activity-heading">Activity</h2>

      {items.length === 0 ? (
        <p className="empty">Nothing has happened on this board yet.</p>
      ) : (
        <ul className="activity-list" aria-live="polite" aria-relevant="additions">
          {items.map((item) => (
            <li key={item.id} className="activity-item">
              <span className="activity-actor">{item.actorName}</span> {verbFor(item.type)}{' '}
              <strong>{item.subject}</strong>
              {item.detail ? ` ${item.detail}` : ''}
              <time className="activity-when" dateTime={item.createdAt}>
                {formatWhen(item.createdAt)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

/**
 * The verb for an activity type.
 *
 * A table rather than a string built from the type, because "card.archived"
 * becomes "archived" and "member.role_changed" does not become "role_changed" in
 * any sentence a person would write. Every key is present, so a new activity type
 * added to the enum without a verb here is a type error rather than a feed line
 * reading "Ana card.unarchived Fix login".
 */
const VERBS: Record<Activity['type'], string> = {
  'board.created': 'created the board',
  'board.renamed': 'renamed the board to',
  'member.added': 'added',
  'member.role_changed': 'changed the role of',
  'member.removed': 'removed',
  'list.created': 'added the list',
  'list.renamed': 'renamed a list to',
  'list.moved': 'moved the list',
  'list.archived': 'archived the list',
  'card.created': 'added',
  'card.updated': 'edited',
  'card.moved': 'moved',
  'card.archived': 'archived',
};

function verbFor(type: Activity['type']): string {
  return VERBS[type];
}

/**
 * A timestamp as `HH:MM`, in the reader's own zone.
 *
 * `Intl` with no explicit locale, deliberately: this is a wall-clock time on a
 * board the reader is looking at right now, and "who moved that, and when" is
 * answered in their zone or not at all. The date lives in the `dateTime`
 * attribute for anything that wants the instant.
 */
function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  );
}
