import { describe, expect, it } from 'vitest';

import { isWithinRelativeHorizon, RELATIVE_HORIZON_SECONDS, relativeTime } from './relative';

const NOW = new Date('2026-03-09T12:00:00Z');
const ago = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);

/**
 * Every expected string below was produced by running `Intl.RelativeTimeFormat`
 * on this machine and pasting the output. None of them was typed from memory.
 *
 * That is not ceremony. `numeric: 'auto'` renders -1 day as "yesterday" and -7
 * days as "last week", not as "1 day ago" and "7 days ago", and it renders 0
 * minutes as "this minute". Guessing any of those produces a test that fails
 * against correct code, which then invites somebody to "fix" the code until the
 * wrong expectation passes.
 *
 * The "this minute" case is the reason the floor in relative.ts is 60 seconds and
 * not the 45 it started as: running the formatter is what surfaced it.
 */
describe('relativeTime', () => {
  it.each([
    [0, 'just now'],
    [59, 'just now'],
    [60, '1 minute ago'],
    [119, '1 minute ago'],
    [120, '2 minutes ago'],
    [3599, '59 minutes ago'],
    [3600, '1 hour ago'],
    [7200, '2 hours ago'],
    [86_399, '23 hours ago'],
    [86_400, 'yesterday'],
    [90_000, 'yesterday'],
    [172_800, '2 days ago'],
    [518_400, '6 days ago'],
    [604_800, 'last week'],
    [1_209_600, '2 weeks ago'],
  ])('renders %i seconds ago as %s', (seconds, expected) => {
    expect(relativeTime(ago(seconds), NOW)).toBe(expected);
  });

  it('rounds towards zero, never up', () => {
    // At 119 seconds "1 minute ago" is true and "2 minutes ago" is not yet.
    // Rounding to nearest would let a row claim to be older than it is, which
    // reads as a bug when the newer row above it rounds the other way.
    expect(relativeTime(ago(119), NOW)).toBe('1 minute ago');
    expect(relativeTime(ago(3599), NOW)).toBe('59 minutes ago');
    expect(relativeTime(ago(86_399), NOW)).toBe('23 hours ago');
  });

  it.each([
    [-59, 'just now'],
    [-60, 'in 1 minute'],
    [-3600, 'in 1 hour'],
    [-86_400, 'tomorrow'],
    [-172_800, 'in 2 days'],
  ])('handles a future instant %i seconds ahead as %s', (seconds, expected) => {
    // Clock skew between the API host and the reader's machine is routinely a few
    // seconds. "in 1 minute" is at least honest about it; clamping to "just now"
    // would hide the skew until something that depends on ordering broke.
    expect(relativeTime(ago(seconds), NOW)).toBe(expected);
  });

  it('speaks the locale it is given', () => {
    expect(relativeTime(ago(120), NOW, 'es-ES')).toBe('hace 2 minutos');
  });

  it('does not read the clock', () => {
    // Two calls a real millisecond apart must agree, because the server and the
    // browser render the same row at different moments and React discards the
    // server's HTML on a mismatch.
    const first = relativeTime(ago(300), NOW);
    const second = relativeTime(ago(300), NOW);
    expect(first).toBe(second);
    expect(first).toBe('5 minutes ago');
  });
});

describe('isWithinRelativeHorizon', () => {
  it('keeps distances useful and hands anything older to the date formatter', () => {
    expect(RELATIVE_HORIZON_SECONDS).toBe(4 * 7 * 24 * 3600);
    expect(isWithinRelativeHorizon(ago(RELATIVE_HORIZON_SECONDS - 1), NOW)).toBe(true);
    expect(isWithinRelativeHorizon(ago(RELATIVE_HORIZON_SECONDS), NOW)).toBe(false);
    // Symmetric: a badly skewed clock four weeks in the future is no more
    // readable as "in 4 weeks" than four weeks in the past is as "4 weeks ago".
    expect(isWithinRelativeHorizon(ago(-RELATIVE_HORIZON_SECONDS), NOW)).toBe(false);
  });
});
