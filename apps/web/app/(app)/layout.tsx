import type { ReactNode } from 'react';

import { Nav } from '../../components/nav';
import { requireUser } from '../../lib/session';
import { SignOutForm } from './sign-out';

/**
 * The signed-in shell.
 *
 * The session is read here, once, for the nav -- not in the root layout. A root
 * layout that awaits `auth()` opts every route into dynamic rendering, including
 * `/login` and `/signup`, which have no session to read. Reading it in this
 * layout scopes that cost to the routes that actually need a user.
 *
 * `requireUser()` redirects rather than rendering an empty shell, so no page
 * under this layout has to check again before fetching.
 */
export default async function AppLayout({
  children,
}: {
  children: ReactNode;
}): Promise<JSX.Element> {
  const user = await requireUser();

  return (
    <div className="shell">
      <Nav name={user.name} signOut={<SignOutForm />} />
      <main id="main" className="page">
        {children}
      </main>
    </div>
  );
}
