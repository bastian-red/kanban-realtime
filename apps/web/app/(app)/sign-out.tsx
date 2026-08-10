import { signOut } from '../../auth';

/**
 * Sign out, through a server action.
 *
 * **Not `<form action="/api/auth/signout" method="post">`.** Auth.js protects
 * that route with a double-submit CSRF token, so a bare POST is rejected and the
 * browser lands back where it started -- signed in, with no error anywhere. That
 * shipped here and was caught by the E2E spec that signs out and then asks for
 * `/boards`: everything looked right, and the session simply never ended.
 *
 * The server action calls `signOut()` on the server, which clears the cookie and
 * redirects, and Next handles the token for the action itself. It also keeps
 * working with JavaScript disabled, which the fetch-based alternative does not.
 */
export function SignOutForm(): JSX.Element {
  return (
    <form
      action={async () => {
        'use server';
        await signOut({ redirectTo: '/login' });
      }}
    >
      <button type="submit" className="button button-quiet button-small">
        Sign out
      </button>
    </form>
  );
}
