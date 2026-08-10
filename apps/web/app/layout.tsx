import type { Metadata, Viewport } from 'next';
import { DM_Mono, Manrope, Sora } from 'next/font/google';
import type { ReactNode } from 'react';

import { appBaseUrl } from '../lib/config';
import './globals.css';

/**
 * The document, the three typefaces, and the one keyboard escape hatch.
 *
 * **`auth()` is not called here, and must not be.** A root layout that awaits the
 * session opts every route in the app into dynamic rendering, including `/login`
 * and `/signup`, which have no session to read and are the two pages that most
 * want to be static. The session is read per route instead: `app/(app)/layout.tsx`
 * reads it once for the nav, and each page reads it again for its own fetch. Both
 * reads hit the same request-scoped cookie, so the cost is a cookie parse rather
 * than a round trip.
 *
 * The three faces are chosen for what a board is used for. Sora carries the board
 * name and the column headers: it is a geometric sans with a wide aperture, which
 * holds up at 13px in a column header where a text serif would read as an article.
 * Manrope is the interface face -- its digits and its `l`/`1` stay separable at
 * 14px, which is where card titles live. DM Mono carries every number a reader
 * compares: WIP counts, card versions, latencies on /status.
 */
const display = Sora({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-display',
  // Only the weight the stylesheet asks for. Every unused weight is a font file
  // a reader downloads for nothing.
  weight: ['600'],
});

const ui = Manrope({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-ui',
  weight: ['400', '500', '600'],
});

const mono = DM_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
  weight: ['400', '500'],
});

export const metadata: Metadata = {
  metadataBase: new URL(appBaseUrl()),
  title: {
    default: 'Kanban',
    template: '%s | Kanban',
  },
  description:
    'A collaborative Kanban board: drag and drop, live sync across every open tab, presence, per-board roles and a permanent activity history.',
};

/**
 * `color-scheme` is what makes the browser paint its own furniture -- scrollbars,
 * form controls, the address bar on mobile -- in the same scheme the stylesheet
 * is using. Without it a dark page keeps a white scrollbar.
 */
export const viewport: Viewport = {
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="en" className={`${display.variable} ${ui.variable} ${mono.variable}`}>
      <body>
        {/* First focusable element on every page. Both layouts below render a
            `<main id="main">`, including the auth pages, so the target always
            exists. */}
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
