import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { openBoard, signIn } from '../fixtures/app';
import { ANA } from '../fixtures/seed-facts';

/**
 * axe over every route, in both colour schemes, with zero violations allowed.
 *
 * **Both schemes, because half the palette only exists in one of them.** The dark
 * block overrides a subset of the light tokens, so a contrast failure introduced
 * there is invisible to a light-mode scan -- and the reverse. `lib/contrast.test.ts`
 * measures the tokens; this measures what the browser actually painted with them,
 * including anything a component composed at runtime.
 *
 * **No `aria-hidden` on anything with a focusable inside it.** dnd-kit makes card
 * handles focusable, and hiding a subtree that contains a focusable is itself a
 * WCAG failure -- the classic way to "fix" an axe finding and create a worse one.
 * The presence avatars are `aria-hidden` and contain no controls; the sentence
 * beside them carries the roster.
 *
 * Nothing here is disabled with a rule exclusion. A violation is either fixed or
 * it is a real finding.
 */
const SCHEMES = ['light', 'dark'] as const;

async function scan(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    // WCAG 2.1 AA is the bar the whole design system is built to, so it is the
    // tag set asserted rather than axe's larger default.
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  // The failure message names the rule and the element, not just a count. An
  // "expected 3 to be 0" tells nobody what to fix.
  const described = results.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.help}\n` +
      violation.nodes.map((node) => `    ${node.target.join(' ')}`).join('\n'),
  );
  expect(described, described.join('\n\n')).toEqual([]);
}

for (const scheme of SCHEMES) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('the login page', async ({ page }) => {
      await page.goto('/login');
      await scan(page);
    });

    test('the signup page', async ({ page }) => {
      await page.goto('/signup');
      await scan(page);
    });

    test('the boards list', async ({ page }) => {
      await signIn(page, ANA.email);
      await scan(page);
    });

    test('the board, live', async ({ page }) => {
      // Scanned after the socket connects, not before: the presence bar, the
      // connection chip and the activity feed are all populated by the socket,
      // and scanning the server-rendered shell would skip most of the page.
      await signIn(page, ANA.email);
      await openBoard(page);
      await scan(page);
    });

    test('the board with an inline form open', async ({ page }) => {
      // A composer is a labelled field that appears where a button was, and its
      // label is visually hidden. A scan of the closed state would never see it.
      await signIn(page, ANA.email);
      await openBoard(page);
      await page.getByRole('button', { name: /Add a card to Backlog/ }).click();
      await expect(page.getByLabel(/Title of the new card in Backlog/)).toBeVisible();
      await scan(page);
    });

    test('the status page', async ({ page }) => {
      await signIn(page, ANA.email);
      await page.goto('/status');
      await expect(page.getByRole('heading', { name: 'Status', level: 1 })).toBeVisible();
      await scan(page);
    });
  });
}
