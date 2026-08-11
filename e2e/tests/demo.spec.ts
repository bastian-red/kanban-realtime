import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import {
  addCard,
  cardIn,
  column,
  createBoard,
  handleFor,
  keyboardMove,
  signIn,
} from '../fixtures/app';
import { ANA, BRUNO } from '../fixtures/seed-facts';

/**
 * The README's demo GIF, captured rather than recorded by hand.
 *
 * **Skipped by default.** `playwright.config.ts` ignores this file unless
 * `DEMO=1`, and `scripts/demo-gif.sh` is what sets it. It holds still for
 * animations, writes files, and takes far longer than any assertion needs -- none
 * of which belongs in the lane that runs on every push.
 *
 * The contract with `scripts/demo-gif.sh`: one PNG per step in `e2e/demo-shots/`,
 * numbered so that a plain lexical sort is playback order. The script does not
 * invent an order of its own.
 *
 * **Two windows in one frame.** The product's claim is that a drag in one browser
 * appears in another, and a single-viewport capture cannot show that. So each
 * frame is a screenshot of the mover's window and the observer's window, taken a
 * moment apart, and the GIF plays them in sequence -- a reader watching the card
 * leave one column in the top shot and arrive in the bottom one is watching the
 * broadcast happen.
 */
const SHOTS = join(__dirname, '..', 'demo-shots');

let step = 0;

async function shot(page: Page, name: string): Promise<void> {
  step += 1;
  // Zero-padded, because `10-` sorts before `2-` otherwise and the GIF plays in
  // the wrong order with nothing to indicate it.
  const file = join(SHOTS, `${String(step).padStart(2, '0')}-${name}.png`);
  // Animations settled: dnd-kit transitions cards over 180ms and a frame caught
  // mid-transform shows a card floating between two columns, which reads as a
  // rendering bug rather than as a drag.
  await page.waitForTimeout(400);
  await page.screenshot({ path: file, fullPage: false });
}

test.describe('demo capture', () => {
  test('captures the board, a live drag and the presence bar', async ({ page, context }) => {
    mkdirSync(SHOTS, { recursive: true });
    // Generous: this test does six page loads, two sign-ins and a socket
    // handshake, and it is not racing anything.
    test.setTimeout(120_000);

    await signIn(page, ANA.email);
    await shot(page, 'boards');

    // Unique per run. The board is built through the UI against a database this
    // script does not reset between attempts, so a fixed name means a second run
    // adds its columns to the first run's board and every column appears twice.
    const boardName = `Launch week ${Date.now()}`;
    await createBoard(page, boardName, ['Backlog', 'In progress', 'Done']);
    await addCard(page, 'Backlog', 'Write the release notes');
    await addCard(page, 'Backlog', 'Cut the 1.0 tag');
    const card = await addCard(page, 'In progress', 'Wire the presence bar');
    await shot(page, 'board');

    // A second person, so the presence bar has somebody in it and the drag has
    // somewhere to arrive.
    await page.getByLabel('Add someone by email').fill(BRUNO.email);
    await page.getByRole('button', { name: 'Add member' }).click();
    await expect(page.getByRole('rowheader', { name: new RegExp(BRUNO.name) })).toBeVisible();

    const observer = await context.newPage();
    await signIn(observer, BRUNO.email);
    await observer.getByRole('link', { name: new RegExp(boardName) }).click();
    await expect(observer.getByText('Live', { exact: true })).toBeVisible({ timeout: 20_000 });

    await expect(page.getByText('1 other person on this board')).toBeVisible({ timeout: 20_000 });
    await shot(page, 'presence');

    // Before: the observer's window, card still in In progress.
    await expect(cardIn(observer, 'In progress', card)).toBeVisible();
    await shot(observer, 'before-the-drag');

    // The move, by keyboard: the same `onDragEnd` a mouse drag reaches, and the
    // path that is reproducible frame to frame. Through the fixture, which waits
    // on dnd-kit's live region rather than on a clock.
    await keyboardMove(page, handleFor(page, 'In progress', card), 'ArrowRight');
    await expect(cardIn(page, 'Done', card)).toBeVisible();
    await shot(page, 'after-the-drag');

    // After: the observer's window, which nobody reloaded.
    await expect(cardIn(observer, 'Done', card)).toBeVisible({ timeout: 15_000 });
    await shot(observer, 'the-other-browser-sees-it');

    // The activity feed, which now has the line the drag wrote.
    await expect(observer.getByRole('complementary', { name: 'Activity' })).toContainText(ANA.name);
    await shot(observer, 'activity');

    // And the operational half, which is what stands in for a deploy here.
    await page.goto('/status');
    await expect(page.getByRole('heading', { name: 'Status', level: 1 })).toBeVisible();
    await shot(page, 'status');

    await column(page, 'Done');
    await observer.close();
  });
});
