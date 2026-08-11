import type { Board } from '@kan/shared';

/**
 * What a screen reader hears during a drag.
 *
 * `@dnd-kit` ships defaults, and the defaults announce the `id` of the thing
 * being dragged. Every id on this board is a cuid, so a reader dragging a card
 * with the keyboard hears
 *
 *     Picked up draggable item cm3x9f2b40001qz7h8k2p1n4d.
 *
 * which is not an announcement, it is a database key read aloud. The keyboard
 * path is the whole reason `KeyboardSensor` is wired up (WCAG 2.1.1); leaving it
 * narrated in cuids means it is operable and unusable, which is the worse of the
 * two failures because it passes an automated audit.
 *
 * So the announcements are built from the board itself, in this file, as pure
 * functions over data. Two consequences worth having:
 *
 * - they are unit-testable with no DOM, no dnd-kit and no browser, which is where
 *   `drag-announcements.test.ts` runs them;
 * - the E2E drag becomes deterministic. `@dnd-kit` renders these into a
 *   `role="status"` live region, so a test can wait for "picked up" before it
 *   presses an arrow key instead of sleeping a guessed number of milliseconds.
 *   That sleep was a real flake: the two-browser drag spec failed on a loaded CI
 *   runner because 200ms was not long enough for the lift to register, and the
 *   card never moved at all.
 *
 * Positions here are **1-based**, because they are read by a person. Everything
 * else in this codebase counts from zero and the difference is deliberate.
 */

/** Where a card sits, or would sit, said the way a person counts. */
export type DragPlace = {
  /** The card's own title, for the sentence. */
  title: string;
  /** The list it is in, or is over. */
  listName: string;
  /** 1-based. */
  position: number;
  /** How many cards the list holds once the card is there. */
  total: number;
};

function cardTitle(board: Board, cardId: string): string | null {
  for (const list of board.lists) {
    const card = list.cards.find((entry) => entry.id === cardId);
    if (card) return card.title;
  }
  return null;
}

/**
 * Where the card is right now.
 *
 * Null when the id is not on the board, which happens for one render after
 * another client archives the card being dragged. An announcement is not worth
 * throwing over, so every caller degrades to silence.
 */
export function originOf(board: Board, cardId: string): DragPlace | null {
  for (const list of board.lists) {
    const index = list.cards.findIndex((entry) => entry.id === cardId);
    if (index !== -1) {
      return {
        title: list.cards[index]!.title,
        listName: list.name,
        position: index + 1,
        total: list.cards.length,
      };
    }
  }
  return null;
}

/**
 * Where the card would land if it were dropped on `overId`.
 *
 * The resolution has to match `BoardClient`'s `onDragEnd` exactly, or the
 * sentence describes a move that does not happen: an `overId` naming a list is a
 * drop at the end of it, an `overId` naming a card is a drop at that card's
 * index, and anything else is not a target.
 *
 * `total` counts the destination **after** the move, so a card crossing into a
 * three-card column is "4 of 4" and not "4 of 3".
 */
export function targetOf(board: Board, cardId: string, overId: string | null): DragPlace | null {
  if (!overId) return null;
  const title = cardTitle(board, cardId);
  if (title === null) return null;

  const target =
    board.lists.find((list) => list.id === overId) ??
    board.lists.find((list) => list.cards.some((entry) => entry.id === overId));
  if (!target) return null;

  const overIndex = target.cards.findIndex((entry) => entry.id === overId);
  const index = overIndex === -1 ? target.cards.length : overIndex;
  const alreadyHere = target.cards.some((entry) => entry.id === cardId);

  return {
    title,
    listName: target.name,
    // Dropping a card on itself is a no-op the sensor still reports, and
    // announcing "position 0" for it would be nonsense.
    position: index + 1,
    total: alreadyHere ? target.cards.length : target.cards.length + 1,
  };
}

/** `Backlog, 2 of 4`. Shared by every sentence below so they stay parallel. */
function place(at: DragPlace): string {
  return `${at.listName}, ${at.position} of ${at.total}`;
}

export function pickedUpMessage(board: Board, cardId: string): string | undefined {
  const at = originOf(board, cardId);
  if (!at) return undefined;
  return `Picked up ${at.title}, in ${place(at)}. Use the arrow keys to move it, space to drop it, escape to put it back.`;
}

export function movedOverMessage(
  board: Board,
  cardId: string,
  overId: string | null,
): string | undefined {
  const at = targetOf(board, cardId, overId);
  if (!at) return undefined;
  return `${at.title} is over ${place(at)}.`;
}

export function droppedMessage(
  board: Board,
  cardId: string,
  overId: string | null,
): string | undefined {
  const at = targetOf(board, cardId, overId);
  if (at) return `Dropped ${at.title} into ${place(at)}.`;

  // Released over nothing. The card stays exactly where it was, and saying so is
  // the point: silence here is indistinguishable from a move that failed.
  const from = originOf(board, cardId);
  return from ? `Dropped ${from.title}. It stayed in ${place(from)}.` : undefined;
}

export function cancelledMessage(board: Board, cardId: string): string | undefined {
  const at = originOf(board, cardId);
  if (!at) return undefined;
  return `Cancelled. ${at.title} is back in ${place(at)}.`;
}
