import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';

import { BOARD, PASSWORD } from './seed-facts';

/**
 * The three things every spec does before it can assert anything: sign in, open a
 * board, and find a card.
 *
 * Locators are by **role and accessible name**, never by CSS class or test id.
 * That is not a style preference here: this board's whole accessibility story is
 * that every state carries a word -- the WIP chip, the presence chip, the drop
 * target, the connection indicator -- and a suite that located things by
 * `.column-name` would pass with every one of those labels deleted. Driving the
 * app the way a screen reader reads it means the specs fail when the labels do.
 */

/** Sign in through the real form, and wait for the boards list. */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // The heading, not the URL: a redirect that lands on an error boundary still
  // changes the URL.
  await expect(page.getByRole('heading', { name: 'Boards', level: 1 })).toBeVisible();
}

/**
 * Open a board and wait until it is **live**, not merely rendered.
 *
 * The distinction matters more here than in any other spec helper. The board is
 * server-rendered, so the columns and cards are on the page before the socket has
 * connected -- and a drag performed in that window is applied optimistically,
 * acknowledged by nobody, and reverted a second later. A spec that raced it would
 * fail intermittently and look like a bug in the reducer.
 *
 * "Live" is the connection indicator's own word, which is also the one a screen
 * reader hears. Waiting for it is waiting for exactly the thing the user waits
 * for.
 */
export async function openBoard(page: Page, name: string = BOARD.name): Promise<void> {
  await page.getByRole('link', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 20_000 });
}

/** A column, by its accessible name -- which includes its WIP words. */
export function column(page: Page, name: string): Locator {
  return page.getByRole('region', { name: new RegExp(`^${escapeRegExp(name)},`) });
}

/** A card's title button, scoped to the column it should be in. */
export function cardIn(page: Page, listName: string, title: string): Locator {
  return column(page, listName).getByRole('button', { name: title, exact: true });
}

/** The drag handle beside a card's title. */
export function handleFor(page: Page, listName: string, title: string): Locator {
  return column(page, listName).getByRole('button', { name: `Move ${title}` });
}

/** Every card title in a column, in the order they are rendered. */
export async function cardTitles(page: Page, listName: string): Promise<string[]> {
  const buttons = column(page, listName).locator('.card-title');
  return (await buttons.allTextContents()).map((text) => text.trim());
}

/**
 * A second signed-in browser, for the live-sync specs.
 *
 * A separate `BrowserContext`, not a second page in the same one: contexts share
 * cookies, so a second page would be the same session and the same socket. Two
 * contexts are two browsers as far as the gateway is concerned, which is what the
 * broadcast has to cross.
 */
export async function secondBrowser(
  context: BrowserContext,
  email: string,
  boardName: string = BOARD.name,
): Promise<Page> {
  const page = await context.newPage();
  await signIn(page, email);
  await openBoard(page, boardName);
  return page;
}

/**
 * dnd-kit's screen-reader live region.
 *
 * Rendered by `@dnd-kit/accessibility` and filled from the sentences in
 * `apps/web/lib/drag-announcements.ts`. It is the only place in the DOM that says
 * what the drag machinery believes is happening, which makes it the one honest
 * thing to wait on.
 *
 * The `aria-live="assertive"` qualifier is not decoration. `components/notice.tsx`
 * renders a success banner as `role="status"` too -- deliberately, a saved change
 * should not interrupt -- and the board shows one after "Add member", which the
 * two-browser drag spec does before it drags. A bare `getByRole('status')` there
 * matches two elements and fails strict mode. dnd-kit's region is the assertive
 * one, because a drag in progress does interrupt.
 */
export function dragAnnouncement(page: Page): Locator {
  return page.getByRole('status').and(page.locator('[aria-live="assertive"]'));
}

/**
 * Move a card with the keyboard, the way dnd-kit's sensor expects.
 *
 * Space lifts, the arrows move, space drops. This exists as a helper because the
 * sequence is the test in several specs and because getting it wrong produces a
 * silent no-op -- the card stays put, the assertion fails, and nothing says the
 * lift never happened.
 *
 * **Every wait here is on an announcement, not on a clock.** The first version
 * slept 150-200ms between keys, which passed locally for weeks and then failed on
 * a loaded CI runner: the lift had not registered when `ArrowRight` arrived, the
 * arrow went to the page instead of to the sensor, and the card never moved. A
 * timeout tuned to one machine is not a synchronisation primitive, and dnd-kit
 * already publishes its own state on every transition.
 *
 * What it waits for is the sentence **changing**, never a particular word in it,
 * and that distinction was itself a failed attempt. Waiting for "Picked up" times
 * out: the region holds one string, and dnd-kit fires `onDragOver` in the same
 * tick as `onDragStart` because the card is immediately over its own column, so
 * the pick-up sentence is overwritten by "X is over Backlog, 1 of 1" before any
 * polling can see it. Waiting for "is over" fails the other way -- after the first
 * arrow the text already matches, so every later press goes into the previous
 * animation frame, which is the original bug with a nicer-looking wait in front of
 * it. Only "different from what it said a moment ago" holds at every step,
 * including the second `keyboardMove` in a test, where the region still carries
 * "Dropped ..." from the first.
 */
export async function keyboardMove(
  page: Page,
  handle: Locator,
  key: 'ArrowRight' | 'ArrowLeft' | 'ArrowDown' | 'ArrowUp',
  times = 1,
): Promise<void> {
  const announcement = dragAnnouncement(page);

  /** Press, and wait until the drag machinery says something new about it. */
  const press = async (stroke: string): Promise<void> => {
    // Trimmed, because `toHaveText` normalises whitespace on the value it reads
    // and `textContent()` does not. Untrimmed, a sentence that differs only by a
    // stray space would compare unequal and the wait would return immediately.
    const before = ((await announcement.textContent()) ?? '').trim();
    await page.keyboard.press(stroke);
    await expect(announcement).not.toHaveText(before);
  };

  await handle.focus();
  // The lift. Before it the region is empty, or holds the previous drag's last
  // sentence; either way the sensor is not listening for arrows yet.
  await press('Space');
  for (let index = 0; index < times; index += 1) await press(key);
  await press('Space');

  // And the drop specifically, rather than "something changed". A cancelled drag
  // also changes the text, and it leaves the card where it started with every
  // wait above satisfied.
  await expect(announcement).toContainText('Dropped');
}

/**
 * The app's own alert banner.
 *
 * `getByRole('alert')` alone is ambiguous: Next mounts a permanently empty
 * `<div role="alert" id="__next-route-announcer__">` on every page for route
 * announcements, so a bare role query is a strict-mode violation that reads as
 * "the app rendered two errors". Filtering on having any text at all picks the
 * one with a message in it, and keeps the query on the role rather than on a
 * class the design could rename.
 */
export function alertBanner(page: Page): Locator {
  return page.getByRole('alert').filter({ hasText: /\S/ });
}

/**
 * Create a card in a named column and return its title.
 *
 * Specs that need a card to move create their own rather than reaching for a
 * seeded one. The suite runs serially against one database without reseeding
 * between files, so a spec that drags `Wire the presence bar` out of `In progress`
 * leaves every later spec asserting about a card that is no longer there -- and
 * the failure reads as a broken board rather than as a shared fixture.
 */
export async function createBoard(page: Page, name: string, lists: string[]): Promise<void> {
  // Through the UI, from the boards list, so the spec exercises the same path a
  // person does -- and so the board it drags on has *exactly* the columns it
  // asked for. Specs that shared the seeded board were reading a layout every
  // earlier spec had been adding columns to, which made "one column to the right"
  // mean different things depending on what had run before.
  await page.goto('/boards');
  await page.getByLabel('New board').fill(name);
  await page.getByRole('button', { name: 'Create board' }).click();
  await page.getByRole('link', { name: new RegExp(escapeRegExp(name)) }).click();
  await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 20_000 });

  for (const list of lists) {
    await page.getByRole('button', { name: /Add a list/ }).click();
    await page.getByLabel('Name of the new list').fill(list);
    await page.getByRole('button', { name: 'Add list' }).click();
    await expect(column(page, list)).toBeVisible();
  }
}

export async function addCard(page: Page, listName: string, title: string): Promise<string> {
  await column(page, listName)
    .getByRole('button', { name: new RegExp(`Add a card to ${escapeRegExp(listName)}`) })
    .click();
  await page
    .getByLabel(new RegExp(`Title of the new card in ${escapeRegExp(listName)}`))
    .fill(title);
  await page.getByRole('button', { name: 'Add card' }).click();
  await expect(cardIn(page, listName, title)).toBeVisible();
  return title;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
