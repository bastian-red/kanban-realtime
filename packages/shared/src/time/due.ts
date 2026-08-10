/**
 * What a due date means today, as a state and as a word.
 *
 * The design rule for this project is that no state is carried by colour alone,
 * and a due badge is one of the three places that rule bites (the others are
 * presence and drag). A red pill on a card is invisible to a deuteranopic reader
 * scanning a board, and it is meaningless to a screen reader. So the state comes
 * out of this module already paired with the text that names it, and the UI is
 * not given the option of rendering the state without the word.
 *
 * Pure: `today` is an argument. Which day it is depends on the reader's zone, and
 * `time/day.ts` `today()` is the one function that resolves that -- deliberately
 * not called from here, so the state a card shows is a function of two explicit
 * values and can be tested without a clock.
 */
import { type CalendarDay, daysBetween } from './day';

/**
 * Five states, not three.
 *
 * `today` and `tomorrow` are split out of a generic "soon" because they are the
 * two a person acts on, and a board's whole job is to show what to act on.
 * `none` is a real state rather than a null: a card with no due date must render
 * something explicit in the accessible name, or a screen-reader user hears the
 * card's title and cannot tell whether the date was absent or merely unread.
 */
export type DueState = 'overdue' | 'today' | 'tomorrow' | 'upcoming' | 'none';

export interface Due {
  readonly state: DueState;
  /**
   * Whole days from today. Negative when overdue, 0 today, null with no due date.
   * Exposed so the UI can write "3 days late" without recomputing the subtraction
   * and disagreeing with the state beside it.
   */
  readonly daysAway: number | null;
}

export function dueFor(dueOn: CalendarDay | null | undefined, todayValue: CalendarDay): Due {
  if (!dueOn) return { state: 'none', daysAway: null };
  const daysAway = daysBetween(todayValue, dueOn);
  if (daysAway < 0) return { state: 'overdue', daysAway };
  if (daysAway === 0) return { state: 'today', daysAway };
  if (daysAway === 1) return { state: 'tomorrow', daysAway };
  return { state: 'upcoming', daysAway };
}

/**
 * The words beside the badge.
 *
 * English only, and that is a decision rather than an omission: the whole app is
 * English, and a half-translated interface that says "Overdue by
 * 3 días" is worse than one that does not pretend. If a second locale is ever
 * added, this function is the single place that changes, which is the reason the
 * text lives here and not in a component.
 *
 * Plurals are handled by `Intl.PluralRules` rather than by `n === 1 ? '' : 's'`.
 * The ternary is right for English and wrong for most of the languages this would
 * grow into, and the standard library already knows the rule.
 */
export function dueLabel(due: Due, locale = 'en-GB'): string {
  const plural = (count: number, one: string, other: string): string =>
    new Intl.PluralRules(locale).select(count) === 'one' ? one : other;

  switch (due.state) {
    case 'overdue': {
      const late = Math.abs(due.daysAway ?? 0);
      return `Overdue by ${late} ${plural(late, 'day', 'days')}`;
    }
    case 'today':
      return 'Due today';
    case 'tomorrow':
      return 'Due tomorrow';
    case 'upcoming': {
      const away = due.daysAway ?? 0;
      return `Due in ${away} ${plural(away, 'day', 'days')}`;
    }
    case 'none':
      return 'No due date';
  }
}
