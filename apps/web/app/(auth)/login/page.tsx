import type { Metadata } from 'next';
import Link from 'next/link';

import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage(): JSX.Element {
  return (
    <>
      <h1>Sign in</h1>
      <p className="lede">Your boards, and everybody else&rsquo;s changes to them, live.</p>
      <LoginForm />
      <p className="auth-foot">
        No account yet? <Link href="/signup">Create one</Link>.
      </p>
    </>
  );
}
