import { describe, expect, it } from 'vitest';

import { toQueryString } from './query';

/**
 * The query string, and the one encoding that has to be wrong to be right.
 *
 * What it pins: a false boolean is never sent. Zod's `z.coerce.boolean()` is
 * `Boolean(value)`, and every non-empty string is truthy, so `Boolean("false")`
 * is `true`. Sending `flag=false` turns the flag **on** at the other end -- the
 * filter narrows instead of widening, and nothing reports an error anywhere.
 *
 * What breaks without it: nothing loudly. The parameter is accepted, the request
 * succeeds, and the answer is the opposite of the one asked for.
 */
describe('toQueryString', () => {
  it('encodes strings and numbers', () => {
    expect(toQueryString({ cursor: 'abc', limit: 25 })).toBe('?cursor=abc&limit=25');
  });

  it('omits a false boolean rather than sending false', () => {
    // The line this file exists for.
    expect(toQueryString({ archived: false })).toBe('');
    expect(toQueryString({ archived: true })).toBe('?archived=true');
  });

  it('treats undefined, null and the empty string as unset', () => {
    expect(toQueryString({ a: undefined, b: null, c: '' })).toBe('');
  });

  it('returns an empty string, not a bare question mark, when nothing is set', () => {
    // `${path}?` is a different URL from `${path}` to a cache and to some
    // routers, and it is the shape a naive implementation produces.
    expect(toQueryString({})).toBe('');
  });

  it('percent-encodes values', () => {
    expect(toQueryString({ q: 'fix login & auth' })).toBe('?q=fix+login+%26+auth');
  });

  it('keeps a zero, which is a value rather than an absence', () => {
    // `if (!value) continue` would drop this, and 0 is a legitimate limit or
    // offset in a way that '' and null are not.
    expect(toQueryString({ limit: 0 })).toBe('?limit=0');
  });
});
