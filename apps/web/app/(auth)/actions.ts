'use server';

import { credentialsSchema, sessionUserSchema, signupSchema } from '@kan/shared';
import { AuthError } from 'next-auth';
import { redirect } from 'next/navigation';

import { signIn } from '../../auth';
import { apiRequest } from '../../lib/api';
import { describeFailure, failed, type ActionResult } from '../../lib/action-result';
import { endpoints } from '../../lib/endpoints';

/**
 * Sign in, then go to the boards list.
 *
 * **`redirect()` is called outside the try/catch, and must stay that way.** It
 * works by throwing a `NEXT_REDIRECT` error that Next catches upstream; wrapping
 * it in the catch below would swallow the throw and return a "something went
 * wrong" result to a browser that had just signed in successfully.
 *
 * **`auth()` is not called after `signIn`, and must not be.** The session cookie
 * that `signIn(..., { redirect: false })` produces is on the *response*, and
 * `auth()` reads the *request* -- so it returns null for a sign-in that just
 * worked, and the action reports "the sign-in did not produce a session" for
 * every correct password. That bug shipped in a sibling project, survived curl
 * and a smoke test that posted straight to the credentials callback, and was
 * caught only by Playwright driving the real form.
 */
export async function signInAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) return failed('Enter an email address and a password.');

  try {
    await signIn('credentials', { ...parsed.data, redirect: false });
  } catch (error) {
    // Auth.js turns every `authorize` failure into `CredentialsSignin`, which is
    // correct: "no such account" and "wrong password" are the same answer to
    // anyone who is not the account holder.
    if (error instanceof AuthError) return failed('That email and password do not match.');
    return failed(describeFailure(error));
  }

  redirect('/');
}

/**
 * Create an account, then sign in with the credentials just used.
 *
 * The API owns the user table and the password hash; this forwards the form once
 * and gets a `SessionUser` back. Signing in afterwards rather than trusting that
 * response is deliberate: it is the same code path an existing user takes, so
 * there is one way a session comes into existence rather than two.
 */
export async function signUpAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = signupSchema.safeParse({
    name: formData.get('name'),
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return failed(parsed.error.issues.map((issue) => issue.message).join(' '));
  }

  try {
    await apiRequest(endpoints.signup, sessionUserSchema, { method: 'POST', json: parsed.data });
    await signIn('credentials', {
      email: parsed.data.email,
      password: parsed.data.password,
      redirect: false,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return failed('The account was created but the sign-in failed. Try signing in.');
    }
    return failed(describeFailure(error));
  }

  redirect('/');
}
