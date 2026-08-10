import { describe, expect, it } from 'vitest';

import { day } from './day';
import { type Due, dueFor, dueLabel } from './due';

const TODAY = day('2026-03-09');

describe('dueFor', () => {
  it.each([
    ['2026-03-06', 'overdue', -3],
    ['2026-03-08', 'overdue', -1],
    ['2026-03-09', 'today', 0],
    ['2026-03-10', 'tomorrow', 1],
    ['2026-03-11', 'upcoming', 2],
    ['2026-04-09', 'upcoming', 31],
  ])('reads %s as %s', (due, state, daysAway) => {
    expect(dueFor(day(due), TODAY)).toEqual({ state, daysAway });
  });

  it('treats a missing due date as a state, not as a null to check for', () => {
    // The alternative is `card.dueOn && <DueBadge/>`, which renders nothing at
    // all -- so a screen-reader user hears the card title and cannot tell whether
    // the date was absent or whether they missed it.
    expect(dueFor(null, TODAY)).toEqual({ state: 'none', daysAway: null });
    expect(dueFor(undefined, TODAY)).toEqual({ state: 'none', daysAway: null });
  });

  it('crosses a month boundary without an off-by-one', () => {
    expect(dueFor(day('2026-03-01'), day('2026-02-28'))).toEqual({
      state: 'tomorrow',
      daysAway: 1,
    });
    // 2024 is a leap year: 29 February exists, so 1 March is two days after the
    // 28th, not one.
    expect(dueFor(day('2024-03-01'), day('2024-02-28'))).toEqual({
      state: 'upcoming',
      daysAway: 2,
    });
  });
});

describe('dueLabel', () => {
  // Every state has words. This is the design rule the brief names for this
  // project: an overdue card cannot be signalled by a red pill alone, because
  // that channel does not exist for a deuteranopic reader or for a screen
  // reader. If a state ever renders with no text, this suite is where it fails.
  it.each([
    [{ state: 'overdue', daysAway: -3 }, 'Overdue by 3 days'],
    [{ state: 'overdue', daysAway: -1 }, 'Overdue by 1 day'],
    [{ state: 'today', daysAway: 0 }, 'Due today'],
    [{ state: 'tomorrow', daysAway: 1 }, 'Due tomorrow'],
    [{ state: 'upcoming', daysAway: 2 }, 'Due in 2 days'],
    [{ state: 'none', daysAway: null }, 'No due date'],
  ] as [Due, string][])('labels %j as %s', (due, label) => {
    expect(dueLabel(due)).toBe(label);
  });

  it('pluralises through Intl rather than through a ternary', () => {
    // "Overdue by 1 days" is the bug this rules out. `Intl.PluralRules` is asked
    // because `n === 1` is right for English and wrong for most languages this
    // string would grow into.
    expect(dueLabel({ state: 'overdue', daysAway: -1 })).toContain('1 day');
    expect(dueLabel({ state: 'overdue', daysAway: -1 })).not.toContain('1 days');
    expect(dueLabel({ state: 'upcoming', daysAway: 21 })).toBe('Due in 21 days');
  });

  it('never returns an empty string for any state', () => {
    const states: Due[] = [
      { state: 'overdue', daysAway: -1 },
      { state: 'today', daysAway: 0 },
      { state: 'tomorrow', daysAway: 1 },
      { state: 'upcoming', daysAway: 5 },
      { state: 'none', daysAway: null },
    ];
    for (const due of states) expect(dueLabel(due).length).toBeGreaterThan(0);
  });
});
