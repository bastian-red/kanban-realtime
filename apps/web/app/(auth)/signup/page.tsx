import type { Metadata } from 'next';
import Link from 'next/link';

import { SignupForm } from './signup-form';

export const metadata: Metadata = { title: 'Create an account' };

export default function SignupPage(): JSX.Element {
  return (
    <>
      <h1>Create an account</h1>
      <p className="lede">A starter board is created with it, so there is something to drag.</p>
      <SignupForm />
      <p className="auth-foot">
        Already have one? <Link href="/login">Sign in</Link>.
      </p>
    </>
  );
}
