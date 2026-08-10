import { expect, test } from '@playwright/test';

import {
  addCard,
  cardIn,
  cardTitles,
  column,
  createBoard,
  handleFor,
  openBoard,
  secondBrowser,
  signIn,
} from '../fixtures/app';
import { ANA, BRUNO } from '../fixtures/seed-facts';

/**
 * Two browsers, one board.
 *
 * This is the spec the project is judged on, and the reason it needs two browser
 * contexts rather than two pages is worth stating: **the optimistic update makes
 * a single-browser drag pass without a server**. The card moves in the DOM the
 * moment it is dropped, before any round trip, so a one-context assertion is an
 * assertion about the client's own guess. Only a *second* browser seeing the card
 * arrive proves the write reached Postgres, the gateway broadcast it, and the
 * other client applied it.
 *
 * `scripts/e2e.sh` runs one gateway; the integration lane runs two and proves the
 * Redis adapter carries a broadcast between them. Between them the two lanes cover
 * "the browser does the right thing" and "the right thing crosses replicas".
 */
test.describe('live sync between two browsers', () => {
  test('a drag in one browser appears in the other, with no reload', async ({ page, context }) => {
    await signIn(page, ANA.email);

    // Its own board with exactly two columns, not the seeded one. "One column to
    // the right" has to mean something fixed, and the seeded board accumulates
    // columns as other specs add them -- so a keyboard move that lands in `Done`
    // when this file runs alone lands somewhere else when the whole suite does.
    const boardName = `Sync ${Date.now()}`;
    await createBoard(page, boardName, ['Left', 'Right']);
    const card = await addCard(page, 'Left', 'Crosses browsers');

    // The observer has to be a member to see it, so the owner adds them first.
    await page.getByLabel('Add someone by email').fill(BRUNO.email);
    await page.getByRole('button', { name: 'Add member' }).click();
    await expect(page.getByRole('rowheader', { name: new RegExp(BRUNO.name) })).toBeVisible();

    const observer = await secondBrowser(context, BRUNO.email, boardName);

    // Both browsers agree on where the card starts.
    await expect(cardIn(page, 'Left', card)).toBeVisible();
    await expect(cardIn(observer, 'Left', card)).toBeVisible();

    // The move, by keyboard rather than by mouse. dnd-kit's pointer sensor needs
    // a real drag gesture with intermediate mousemove events, and Playwright's
    // `dragTo` sends too few for the sensor's 6px activation constraint -- it
    // works about half the time, which is worse than not working. The keyboard
    // path is the same `onDragEnd`, and it is also the path a WCAG 2.1.1 failure
    // would show up in.
    const handle = handleFor(page, 'Left', card);
    await handle.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    await page.keyboard.press('Space');

    // The mover sees it. This alone would pass with the server switched off.
    await expect(cardIn(page, 'Right', card)).toBeVisible();

    // The other browser sees it, which is the actual assertion. Nothing was
    // reloaded: this page has been sitting still since it opened.
    await expect(cardIn(observer, 'Right', card)).toBeVisible({ timeout: 15_000 });
    await expect(cardIn(observer, 'Left', card)).toHaveCount(0);
  });

  test('a card added in one browser appears in the other', async ({ page, context }) => {
    await signIn(page, ANA.email);
    await openBoard(page);
    const observer = await secondBrowser(context, BRUNO.email);

    const title = await addCard(page, 'Backlog', `Added at ${Date.now()}`);

    await expect(cardIn(observer, 'Backlog', title)).toBeVisible({ timeout: 15_000 });
  });

  test('a rename in one browser appears in the other, without moving its cards', async ({
    page,
    context,
  }) => {
    // The reason `list.updated` carries a header and not a list. If it shipped
    // `cards` too, this rename would replace the observer's card array with the
    // renamer's snapshot -- silently undoing any drag that landed a moment
    // earlier.
    await signIn(page, ANA.email);

    // Its own board, because this spec *renames a column permanently*. Run
    // against the seeded board it leaves `Ready` called something else, and the
    // next browser project -- Firefox, after Chromium -- then fails to find a
    // column the seed says exists. That contamination crossed projects rather
    // than files, which is the hardest kind to attribute.
    const boardName = `Rename ${Date.now()}`;
    await createBoard(page, boardName, ['Original']);
    await addCard(page, 'Original', 'Stays put');

    await page.getByLabel('Add someone by email').fill(BRUNO.email);
    await page.getByRole('button', { name: 'Add member' }).click();
    await expect(page.getByRole('rowheader', { name: new RegExp(BRUNO.name) })).toBeVisible();

    const observer = await secondBrowser(context, BRUNO.email, boardName);

    const before = await cardTitles(observer, 'Original');
    expect(before).toEqual(['Stays put']);
    const renamed = 'Renamed live';

    await column(page, 'Original')
      .getByRole('button', { name: /^Rename/ })
      .click();
    await page.getByLabel(/Rename Original/).fill(renamed);
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(column(observer, renamed)).toBeVisible({ timeout: 15_000 });
    expect(await cardTitles(observer, renamed)).toEqual(before);
  });

  test('presence shows the other person, by name and activity', async ({ page, context }) => {
    await signIn(page, ANA.email);
    await openBoard(page);

    // Alone at first. The sentence is the accessible channel; the avatars are
    // `aria-hidden` because eight of them announced one by one is noise.
    await expect(page.getByText('Nobody else is on this board')).toBeVisible();

    const observer = await secondBrowser(context, BRUNO.email);

    // One *other* person, said in words rather than shown as a second coloured
    // dot. The reader is excluded from the roster, because "who else is here" is
    // the question presence answers.
    await expect(page.getByText('1 other person on this board')).toBeVisible({ timeout: 20_000 });

    // And named, on the chip a sighted reader hovers and a screen reader reads.
    await expect(page.locator('.presence-chip')).toHaveAttribute('title', new RegExp(BRUNO.name));

    await observer.close();

    // And gone again when they leave, without waiting for the TTL: the
    // `disconnecting` handler clears the roster entry while `socket.rooms` still
    // says which boards to clear.
    await expect(page.getByText('Nobody else is on this board')).toBeVisible({ timeout: 20_000 });
  });

  test('the activity feed gains a line for somebody else’s change', async ({ page, context }) => {
    await signIn(page, ANA.email);
    await openBoard(page);
    const observer = await secondBrowser(context, BRUNO.email);

    const title = await addCard(observer, 'Backlog', `Feed check ${Date.now()}`);

    // Attributed to the actor by name, which comes from the service token's
    // `name` claim rather than from a join on the hot path.
    const feed = page.getByRole('complementary', { name: 'Activity' });
    await expect(feed).toContainText(BRUNO.name, { timeout: 15_000 });
    await expect(feed).toContainText(title);
  });

  test('the board survives a reload and reconnects', async ({ page }) => {
    // The reconnect path is where a token handed down as a prop breaks: it lives
    // two minutes, so a board reloaded later would hand the gateway an expired
    // credential and retry with it forever. `/api/realtime-token` is fetched per
    // connection attempt for exactly this.
    await signIn(page, ANA.email);
    await openBoard(page);

    const card = await addCard(page, 'Backlog', `Survives a reload ${Date.now()}`);

    await page.reload();
    await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(cardIn(page, 'Backlog', card)).toBeVisible();
  });
});
