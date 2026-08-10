import { ApiError, ContractError } from './api';

/**
 * What a server action hands back to the form that called it.
 *
 * Every mutation in this app is a server action invoked from a client component,
 * and every one of them can fail in the same three ways: the browser sent
 * something the API refused (400), the API refused for a business reason (409 on
 * an overlapping budget), or the API is not answering. A thrown error would
 * unmount the form into the error boundary and take the user's typing with it,
 * which is the wrong outcome for "that email is already taken".
 *
 * So actions resolve rather than throw, and the form renders `error` in a
 * `role="alert"`. The one exception is a redirect: `redirect()` throws
 * `NEXT_REDIRECT` by design and must reach Next, which is why `toActionResult`
 * is never wrapped around a call that redirects.
 */
export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

export const ok = (message: string): ActionResult => ({ ok: true, message });
export const failed = (error: string): ActionResult => ({ ok: false, error });

/**
 * Turn whatever an action threw into a sentence a person can act on.
 *
 * An `ApiError` already carries the API's own message, which for a validation
 * failure is the list of fields that were wrong — far more useful than "Bad
 * Request". A `ContractError` is a bug in one of the two sides rather than
 * anything the user did, so it is logged with its zod path and reported as an
 * internal fault, because telling someone "expected string, received null at
 * items.3.merchant" helps nobody holding a bank statement.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof ContractError) {
    console.error('[contract]', error.message);
    return 'The server answered with something this page could not read. Nothing was saved.';
  }
  if (error instanceof Error) {
    console.error('[action]', error);
    return `Something went wrong: ${error.message}`;
  }
  console.error('[action] non-error thrown:', error);
  return 'Something went wrong. Nothing was saved.';
}

/** Run an action body, converting any failure into a result the form can render. */
export async function runAction(
  successMessage: string,
  body: () => Promise<void>,
): Promise<ActionResult> {
  try {
    await body();
  } catch (error) {
    return failed(describeFailure(error));
  }
  return ok(successMessage);
}
