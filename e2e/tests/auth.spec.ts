import { expect, test } from '@playwright/test';

import { alertBanner, signIn } from '../fixtures/app';
import { ANA, PASSWORD } from '../fixtures/seed-facts';

/**
 * Sign-in, through the real form.
 *
 * This spec exists because of a bug that shipped in a sibling project and could
 * only be caught here. The sign-in action called `auth()` after
 * `signIn(..., { redirect: false })` to confirm a session had been created --
 * but that cookie is on the **response**, and `auth()` reads the **request**, so
 * every correct password produced "the sign-in did not produce a session".
 *
 * Both cheaper lanes missed it. `curl` and `scripts/dev-smoke.sh` post straight to
 * Auth.js's credentials callback, which is a different code path from the server
 * action the form submits. Only a browser driving the real form goes through the
 * action.
 */
test.describe('signing in', () => {
  test('a correct password reaches the boards list', async ({ page }) => {
    await signIn(page, ANA.email);
    await expect(page).toHaveURL(/\/boards$/);
    // Content from the database, not just a heading the shell renders.
    await expect(page.getByRole('link', { name: /Product launch/ })).toBeVisible();
  });

  test('a wrong password says so, and stays on the form', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(ANA.email);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // `role="alert"`, so a screen reader is interrupted rather than left to
    // discover the failure by re-reading the page.
    await expect(alertBanner(page)).toContainText(/do not match/i);
    await expect(page).toHaveURL(/\/login$/);
  });

  test('an unknown account fails identically to a wrong password', async ({ page }) => {
    // "No such account" and "wrong password" are the same answer to anyone who is
    // not the account holder. A different message here is an account-enumeration
    // oracle.
    await page.goto('/login');
    await page.getByLabel('Email').fill('nobody@kanban.local');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(alertBanner(page)).toContainText(/do not match/i);
  });

  test('a signed-out visitor is sent to the login page', async ({ page }) => {
    await page.goto('/boards');
    await expect(page).toHaveURL(/\/login/);
  });

  test('signing out ends the session', async ({ page }) => {
    await signIn(page, ANA.email);
    await page.getByRole('button', { name: 'Sign out' }).click();

    // Wait for the action to land before asking for a protected route. The click
    // returns as soon as the request is sent, so navigating immediately races the
    // server action that clears the cookie -- and the race is won often enough
    // locally to look like a passing test and lost often enough on CI to look
    // like a broken one.
    await expect(page).toHaveURL(/\/login/);

    await page.goto('/boards');
    await expect(page).toHaveURL(/\/login/);
  });

  test('the skip link is the first thing a keyboard reaches', async ({ page }) => {
    // On a plain load, not after a form submit. Chromium keeps a sequential focus
    // navigation starting point across a same-document form navigation, so a Tab
    // sent right after signing in resumes from where the submit button was and
    // skips everything above it -- including this link. That is a browser
    // behaviour, not an app one, and asserting through it would be asserting
    // about Chromium.
    await page.goto('/login');

    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() =>
      document.activeElement ? document.activeElement.className : 'none',
    );

    expect(focused, `first Tab focused "${focused}"`).toContain('skip-link');
  });

  test('the skip link jumps to the main content', async ({ page }) => {
    // The half that matters. A link that is focusable and points at nothing is a
    // WCAG 2.4.1 failure that looks like a pass.
    await page.goto('/login');

    // Focus and Enter, not `click()`. The link sits at `left: -9999px` until it
    // is focused, so Playwright's actionability check waits for an element that
    // is deliberately off-screen and times out after a minute. Keyboard
    // activation is also the only way a person reaches it.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');

    await expect(page.locator('#main')).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#main');
  });
});
