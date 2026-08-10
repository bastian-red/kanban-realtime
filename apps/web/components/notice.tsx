import type { ActionResult } from '../lib/action-result';

/**
 * A result banner, with the outcome written out.
 *
 * The glyph is a character in the markup rather than a CSS `::before`, and the
 * word "Error"/"Saved" is in the accessible name. Two channels beside the colour,
 * because the border colours here are `--ok` and `--wip-over`, which separate by
 * 1.12:1 in greyscale -- measured in `lib/contrast.test.ts`, not assumed.
 *
 * `role="status"` for a success and `role="alert"` for a failure: a screen reader
 * interrupts for the second and waits for a pause on the first, which is the
 * right urgency for each.
 */
export function Notice({ result }: { result: ActionResult | null }): JSX.Element | null {
  if (!result) return null;

  if (result.ok) {
    return (
      <p className="notice notice-ok" role="status">
        <span aria-hidden="true">✓</span>
        <span>
          <span className="visually-hidden">Saved: </span>
          {result.message}
        </span>
      </p>
    );
  }

  return (
    <p className="notice notice-error" role="alert">
      <span aria-hidden="true">!</span>
      <span>
        <span className="visually-hidden">Error: </span>
        {result.error}
      </span>
    </p>
  );
}
