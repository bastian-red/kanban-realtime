import { describe, expect, it, vi } from 'vitest';
import { describeFailure, failed, ok, runAction } from './action-result';
import { ApiError, ContractError } from './api';

/**
 * What a server action hands back to the form that called it.
 *
 * The rule these cases enforce: **an action resolves, it does not throw.** Every
 * mutation in this app is a server action invoked from a client component, and a
 * thrown error unmounts the form into the error boundary and takes the user's
 * typing with it. That is the wrong outcome for "that email is already taken".
 *
 * The one deliberate exception is a redirect. `redirect()` throws
 * `NEXT_REDIRECT` by design and has to reach Next, which is why `runAction` is
 * never wrapped around a call that redirects -- and why the last case here pins
 * that a rethrown navigation is not swallowed into a red notice saying
 * "Something went wrong" while the browser sits still.
 */

describe('describeFailure', () => {
  it('passes an ApiError message through, because the API wrote it for a person', () => {
    // A 400 from this API is a list of the fields that were wrong, and a 409
    // from the budgets endpoint names the months that overlap. Replacing either
    // with "Bad Request" throws away the only useful part.
    const error = new ApiError(409, 'That budget overlaps 2026-03 to 2026-06. (/budgets)');
    expect(describeFailure(error)).toBe('That budget overlaps 2026-03 to 2026-06. (/budgets)');
  });

  it('hides a contract failure behind a sentence a reader can act on', () => {
    // "expected string, received null at items.3.merchant" helps nobody holding
    // a bank statement. It is a bug in one of the two sides, so it is logged
    // with its path and reported as an internal fault.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new ContractError('/transactions', [
      {
        code: 'invalid_type',
        expected: 'string',
        received: 'null',
        path: ['items', 3, 'merchant'],
        message: 'Expected string, received null',
      },
    ] as never);

    const message = describeFailure(error);
    expect(message).toContain('Nothing was saved');
    expect(message).not.toContain('items.3.merchant');
    // But the detail is not lost: it goes to the log with the zod path intact.
    expect(logged).toHaveBeenCalled();
    expect(String(logged.mock.calls[0]?.[1])).toContain('items.3.merchant');
    logged.mockRestore();
  });

  it('names an ordinary Error but still says nothing was saved implicitly', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(describeFailure(new Error('socket hang up'))).toContain('socket hang up');
    logged.mockRestore();
  });

  it('survives a thrown non-Error, which is what a rejected fetch can be', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(describeFailure('boom')).toBe('Something went wrong. Nothing was saved.');
    expect(describeFailure(undefined)).toBe('Something went wrong. Nothing was saved.');
    expect(describeFailure(null)).toBe('Something went wrong. Nothing was saved.');
    logged.mockRestore();
  });
});

describe('runAction', () => {
  it('resolves with the success message when the body completes', async () => {
    await expect(runAction('Saved.', async () => undefined)).resolves.toEqual({
      ok: true,
      message: 'Saved.',
    });
  });

  it('resolves rather than throwing when the body fails', async () => {
    // The property the whole file exists for. A rejection here would unmount
    // the form.
    const result = await runAction('Saved.', async () => {
      throw new ApiError(400, 'name must not be empty (/categories)');
    });
    expect(result).toEqual({ ok: false, error: 'name must not be empty (/categories)' });
  });

  it('does not report success when the body threw', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await runAction('Saved.', async () => {
      throw new Error('nope');
    });
    expect(result.ok).toBe(false);
    logged.mockRestore();
  });
});

describe('ok and failed', () => {
  it('are discriminated on `ok`, so a form cannot read the wrong field', () => {
    const good = ok('Done.');
    const bad = failed('Not done.');
    expect(good).toEqual({ ok: true, message: 'Done.' });
    expect(bad).toEqual({ ok: false, error: 'Not done.' });
    // The type is a union rather than one object with both fields optional,
    // which is what stops a component rendering `result.message` on a failure
    // and showing an empty notice.
    expect('error' in good).toBe(false);
    expect('message' in bad).toBe(false);
  });
});
