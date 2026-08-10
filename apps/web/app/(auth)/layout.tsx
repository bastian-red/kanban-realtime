import type { ReactNode } from 'react';

/**
 * The signed-out shell.
 *
 * Separate from `(app)` because these two pages have no session to read, no nav
 * to render and nothing to fetch. A shared layout that called `auth()` would opt
 * them into dynamic rendering for a cookie that is not there.
 *
 * `<main id="main">` is here as well as in the app shell, because the skip link
 * in the root layout targets it on every page.
 */
export default function AuthLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="auth">
      <main id="main" className="auth-card">
        {children}
      </main>
    </div>
  );
}
