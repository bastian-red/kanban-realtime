/**
 * Encoding query parameters, with one rule that is not obvious.
 *
 * **A false boolean is an omission, never a `false` on the wire.** Zod's
 * `z.coerce.boolean()` is `Boolean(value)`, and every non-empty string is truthy,
 * so `Boolean("false")` is `true`. Sending `flag=false` therefore turns the flag
 * **on** at the other end: the user unticks a filter, the result gets narrower
 * instead of wider, and nothing anywhere reports an error. The only correct
 * encoding of "off" is to not send the parameter at all.
 *
 * That is a property of the coercion rather than of any one field, which is why
 * it is handled by a shared helper rather than at each call site, and why
 * `query.test.ts` pins it directly.
 */

/** A value that can be sent. `undefined`, `null` and `''` all mean "not set". */
type QueryValue = string | number | boolean | undefined | null;

export function toQueryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    // The line. See the header.
    if (typeof value === 'boolean') {
      if (value) search.set(key, 'true');
      continue;
    }
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded === '' ? '' : `?${encoded}`;
}
