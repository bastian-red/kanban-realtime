import { describe, expect, it } from 'vitest';

import { endpoints } from './endpoints';

describe('endpoints', () => {
  it('nests every board resource under its board', () => {
    // Not `/cards/:id`. Every write is authorised against a board membership, so
    // the board id belongs in the path rather than in the body where a caller can
    // forget it and the API has to look it up.
    expect(endpoints.cards('b1')).toBe('/boards/b1/cards');
    expect(endpoints.card('b1', 'c1')).toBe('/boards/b1/cards/c1');
    expect(endpoints.list('b1', 'l1')).toBe('/boards/b1/lists/l1');
  });

  it('gives the non-CRUD operations a verb segment', () => {
    expect(endpoints.cardMove('b1', 'c1')).toBe('/boards/b1/cards/c1/move');
    expect(endpoints.cardArchive('b1', 'c1')).toBe('/boards/b1/cards/c1/archive');
    expect(endpoints.listMove('b1', 'l1')).toBe('/boards/b1/lists/l1/move');
    expect(endpoints.listArchive('b1', 'l1')).toBe('/boards/b1/lists/l1/archive');
  });

  it('percent-encodes ids', () => {
    // Cuids are URL-safe today. That is a fact about a column, not a guarantee in
    // the contract, and an unencoded `/` in an id is a request to a different
    // route entirely.
    expect(endpoints.card('a/b', 'c d')).toBe('/boards/a%2Fb/cards/c%20d');
    expect(endpoints.boardMember('b?1', 'u#1')).toBe('/boards/b%3F1/members/u%231');
  });

  it('omits an absent activity cursor rather than sending "undefined"', () => {
    expect(endpoints.activity('b1')).toBe('/boards/b1/activity');
    expect(endpoints.activity('b1', { limit: 25 })).toBe('/boards/b1/activity?limit=25');
    expect(endpoints.activity('b1', { cursor: 'abc', limit: 25 })).toBe(
      '/boards/b1/activity?cursor=abc&limit=25',
    );
  });

  it('keeps the two anonymous endpoints separate from everything else', () => {
    // These are the only two calls that carry no bearer token. Naming them as
    // plain strings rather than functions is the reminder.
    expect(endpoints.login).toBe('/auth/login');
    expect(endpoints.signup).toBe('/auth/signup');
  });
});
