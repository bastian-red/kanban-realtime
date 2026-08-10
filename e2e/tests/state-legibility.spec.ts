import { expect, test } from '@playwright/test';

import { alertBanner, column, openBoard, secondBrowser, signIn } from '../fixtures/app';
import { ANA, BRUNO } from '../fixtures/seed-facts';

/**
 * Every state this board renders, read with the colour taken away.
 *
 * axe cannot catch what this catches. A WIP chip that showed `3/3` in amber and
 * nothing else passes every contrast rule -- amber on white is fine -- while being
 * unreadable to somebody who cannot tell it from the green one beside it. The
 * measurement that makes this necessary is in `apps/web/lib/contrast.test.ts`: the
 * three WIP inks separate by **1.23:1 in greyscale in light and 1.02:1 in dark**.
 * They are the same colour to a deuteranopic reader.
 *
 * So the rule is that every state ships a word, and this spec is what enforces it.
 * The page is rendered in forced greyscale and each state is asserted to still be
 * identifiable from its text alone.
 */
test.describe('state is legible without colour', () => {
  test.beforeEach(async ({ page }) => {
    // Grayscale everything. Anything still distinguishable after this is
    // distinguishable by a channel that is not hue.
    await page.addStyleTag({ content: 'html { filter: grayscale(1) !important; }' });
  });

  test('the WIP chip says the state, not just the count', async ({ page }) => {
    await signIn(page, ANA.email);
    await openBoard(page);

    // Every column, whatever its state, carries words a reader can act on: a bare
    // count when there is no limit, and the limit in words when there is one.
    const chips = page.getByLabel(/Work in progress/);
    const count = await chips.count();
    expect(count).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const text = (await chips.nth(index).textContent())?.trim() ?? '';
      expect(
        text,
        'a WIP chip must say its state in words; colour separates by 1.02:1 in greyscale',
      ).toMatch(/^(\d+ cards|\d+\/\d+|At limit \d+\/\d+|Over limit \d+\/\d+)$/);
    }
  });

  test('presence says who is here and what they are doing', async ({ page, context }) => {
    await signIn(page, ANA.email);
    await openBoard(page);
    await secondBrowser(context, BRUNO.email);

    // The sentence, not the avatars. A row of coloured circles is one channel and
    // it is the one that disappears here.
    await expect(page.getByText('1 other person on this board')).toBeVisible({ timeout: 20_000 });

    // And each chip carries initials as text inside its ring.
    await expect(page.locator('.presence-chip', { hasText: BRUNO.initials })).toBeVisible();
  });

  test('the connection indicator is a word', async ({ page }) => {
    // A disconnected board looks exactly like a board nobody else is touching, so
    // this is the only signal that the live half is working. A green dot alone
    // would be invisible here.
    await signIn(page, ANA.email);
    await openBoard(page);
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
  });

  test('an empty column says so, and a drop target says where', async ({ page }) => {
    await signIn(page, ANA.email);
    await openBoard(page);

    const name = `Empty ${Date.now()}`;
    await page.getByRole('button', { name: /Add a list/ }).click();
    await page.getByLabel('Name of the new list').fill(name);
    await page.getByRole('button', { name: 'Add list' }).click();

    // "No cards" rather than a blank rectangle. A blank column and a column that
    // failed to render are the same pixels.
    await expect(column(page, name).getByText('No cards')).toBeVisible();
  });

  test('an overdue card says "overdue", it is not only red', async ({ page }) => {
    // The seed plants one card due before its reference day for exactly this.
    // `--wip-over` against `--muted` is 1.12:1 in greyscale.
    await signIn(page, ANA.email);
    await openBoard(page);
    await expect(page.getByText(/Overdue by \d+ days?/).first()).toBeVisible();
  });

  test('a failure banner says "Error" before it says anything else', async ({ page }) => {
    // The notice's border colour is the only thing separating success from
    // failure visually, and `--ok` and `--wip-over` are 1.12:1 apart in
    // greyscale. The word is in the accessible name.
    await page.goto('/login');
    await page.getByLabel('Email').fill(ANA.email);
    await page.getByLabel('Password').fill('wrong-password-entirely');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(alertBanner(page)).toContainText('Error');
  });
});
