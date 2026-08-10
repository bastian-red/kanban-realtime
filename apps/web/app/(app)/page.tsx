import { redirect } from 'next/navigation';

/**
 * The root, which is the boards list under a shorter name.
 *
 * A redirect rather than rendering the list here, so there is exactly one URL for
 * it. Two routes rendering the same page means two URLs in the browser history,
 * two entries a bookmark can point at, and an `aria-current` in the nav that is
 * right on one of them.
 *
 * `/boards` is the canonical one because the board itself lives at
 * `/boards/:id`, and a list whose children are nested under a different path is
 * a URL structure that has to be explained.
 */
export default function RootPage(): never {
  redirect('/boards');
}
