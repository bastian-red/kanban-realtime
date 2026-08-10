'use client';

import { useFormState, useFormStatus } from 'react-dom';

import { signUpAction } from '../actions';
import { Notice } from '../../../components/notice';

/**
 * The sign-up form.
 *
 * The minimum length is stated beside the field rather than only enforced, and it
 * is 10 characters with no composition rule. That is `credentialsSchema`'s
 * decision and the reasoning is there: a "one symbol, one digit" rule measurably
 * pushes people toward `Password1!`, and NIST 800-63B has recommended against
 * them since 2017.
 *
 * `aria-describedby` ties the hint to the input, so a screen reader announces the
 * rule when the field is focused rather than leaving it as text somewhere nearby.
 */
export function SignupForm(): JSX.Element {
  const [result, action] = useFormState(signUpAction, null);

  return (
    <form action={action} noValidate>
      <Notice result={result} />

      <div className="field">
        <label htmlFor="name">Name</label>
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          required
          aria-describedby="name-hint"
        />
        <p id="name-hint" className="field-hint">
          Shown on your cards and in the board&rsquo;s history.
        </p>
      </div>

      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required />
      </div>

      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={10}
          required
          aria-describedby="password-hint"
        />
        <p id="password-hint" className="field-hint">
          At least 10 characters. Length is the property that matters; there is no symbol
          requirement.
        </p>
      </div>

      <Submit />
    </form>
  );
}

function Submit(): JSX.Element {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="button button-primary" disabled={pending}>
      {pending ? 'Creating…' : 'Create account'}
    </button>
  );
}
