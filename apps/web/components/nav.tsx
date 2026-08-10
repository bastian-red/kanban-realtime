'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * The top bar.
 *
 * A client component only because `aria-current` needs the active path, which is
 * the one thing on this page that cannot be known on the server without making
 * every route dynamic for it.
 *
 * `aria-current="page"` rather than a class alone: the accent pill is the visual
 * signal and this is the one a screen reader gets. The stylesheet keys its
 * highlight off the attribute, so the two cannot disagree.
 *
 * `aria-label="Primary"` names the landmark, which matters once a page has more
 * than one `<nav>`. It is also what `scripts/dev-smoke.sh` looks for to tell a
 * rendered page apart from an error boundary that answered 200.
 */
const LINKS = [
  { href: '/boards', label: 'Boards' },
  { href: '/status', label: 'Status' },
] as const;

export function Nav({ name, signOut }: { name: string; signOut: ReactNode }): JSX.Element {
  const pathname = usePathname();

  return (
    <header className="topbar">
      <Link className="topbar-brand" href="/">
        Kanban
      </Link>

      <nav className="topbar-nav" aria-label="Primary">
        {LINKS.map((link) => {
          // A prefix test, so a board at `/boards/abc` still marks Boards as the
          // current section. `scripts/dev-smoke.sh` reads these hrefs out of this
          // file and probes every one of them, which is why the list is a literal
          // rather than something built at runtime.
          const current = pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              className="topbar-link"
              href={link.href}
              aria-current={current ? 'page' : undefined}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>

      <div className="topbar-user">
        <span>{name}</span>
        {/*
          Passed in as a child rather than rendered here. This is a client
          component (it needs `usePathname` for `aria-current`), and a server
          action cannot be declared inside one -- so the sign-out form is a server
          component the layout composes in. The alternative, a plain POST to
          Auth.js's signout route, is silently rejected by its CSRF check.
        */}
        {signOut}
      </div>
    </header>
  );
}
