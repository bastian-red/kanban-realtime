'use client';

import { useFormState, useFormStatus } from 'react-dom';

import { signInAction } from '../actions';
import { Notice } from '../../../components/notice';

/**
 * The sign-in form.
 *
 * `useFormState` rather than a hand-rolled `onSubmit`: the action runs on the
 * server, the form keeps working with JavaScript disabled, and the failure comes
 * back as a value rather than a thrown error that would unmount the form and take
 * the typing with it.
 *
 * `autoComplete` is set on both fields. Without `current-password` a password
 * manager will not offer to fill, and without `username` it will not know which
 * account it belongs to.
 */
export function LoginForm(): JSX.Element {
  const [result, action] = useFormState(signInAction, null);

  return (
    <form action={action} noValidate>
      <Notice result={result} />

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
          autoComplete="current-password"
          required
        />
      </div>

      <Submit />
    </form>
  );
}

/**
 * A submit button that says what it is doing.
 *
 * `useFormStatus` has to be read from a child of the form, not from the component
 * that renders it -- the hook subscribes to the nearest form above it, and called
 * in `LoginForm` it would always report `pending: false`.
 */
function Submit(): JSX.Element {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="button button-primary" disabled={pending}>
      {pending ? 'Signing in…' : 'Sign in'}
    </button>
  );
}
