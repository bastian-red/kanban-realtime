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
 * Move a card with the keyboard, the way dnd-kit's sensor expects.
 *
 * Space lifts, the arrows move, space drops. This exists as a helper because the
 * sequence is the test in several specs and because getting it wrong produces a
 * silent no-op -- the card stays put, the assertion fails, and nothing says the
 * lift never happened.
 */
export async function keyboardMove(
  page: Page,
  handle: Locator,
  key: 'ArrowRight' | 'ArrowLeft' | 'ArrowDown' | 'ArrowUp',
  times = 1,
): Promise<void> {
  await handle.focus();
  await page.keyboard.press('Space');
  for (let index = 0; index < times; index += 1) {
    await page.keyboard.press(key);
    // dnd-kit animates between positions and reads the layout after each step.
    // Pressing the next key inside that window is how a two-column move lands one
    // column short.
    await page.waitForTimeout(150);
  }
  await page.keyboard.press('Space');
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
