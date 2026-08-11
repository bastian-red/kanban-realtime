import type { Board, Card, ListHeader } from '@kan/shared';
import { describe, expect, it } from 'vitest';

import {
  cancelledMessage,
  droppedMessage,
  movedOverMessage,
  originOf,
  pickedUpMessage,
  targetOf,
} from './drag-announcements';

const card = (id: string, listId: string, position: string, title: string): Card => ({
  id,
  listId,
  title,
  description: null,
  position,
  version: 1,
  dueOn: null,
  assigneeId: null,
  labels: [],
  createdAt: '2026-08-09T09:00:00.000Z',
  updatedAt: '2026-08-09T09:00:00.000Z',
});

const header = (id: string, name: string, position: string): ListHeader => ({
  id,
  boardId: 'b1',
  name,
  position,
  wipLimit: null,
  wip: { state: 'none', label: '0 cards' },
});

function board(): Board {
  return {
    id: 'b1',
    name: 'Sprint 12',
    role: 'EDITOR',
    updatedAt: '2026-08-09T09:00:00.000Z',
    members: [
      { userId: 'u1', role: 'OWNER', name: 'Ana Ruiz', email: 'ana@kan.local', initials: 'AR' },
    ],
    labels: [],
    lists: [
      {
        ...header('l1', 'Backlog', 'a0'),
        cards: [
          card('c1', 'l1', 'a0', 'Write the release notes'),
          card('c2', 'l1', 'a1', 'Cut the 1.0 tag'),
        ],
      },
      {
        ...header('l2', 'In progress', 'a1'),
        cards: [card('c3', 'l2', 'a0', 'Wire the presence bar')],
      },
      { ...header('l3', 'Done', 'a2'), cards: [] },
    ],
  };
}

describe('where the card is', () => {
  it('reads the title, the list and a 1-based position', () => {
    // 1-based on purpose. Every other index in this codebase counts from zero;
    // this one is read out loud to a person, and "card 0 of 2" is not English.
    expect(originOf(board(), 'c2')).toEqual({
      title: 'Cut the 1.0 tag',
      listName: 'Backlog',
      position: 2,
      total: 2,
    });
  });

  it('is null for a card that is not on the board', () => {
    // Not an exception. Another client can archive the card mid-drag, and an
    // announcement is not worth tearing the board down for.
    expect(originOf(board(), 'gone')).toBeNull();
  });
});

describe('where the card would land', () => {
  it('over a list drops at the end of it', () => {
    // The same rule `BoardClient.onDragEnd` applies: an `overId` naming a list
    // means the end. If these two ever disagree, the sentence describes a move
    // that does not happen, which is worse than no sentence.
    expect(targetOf(board(), 'c1', 'l2')).toEqual({
      title: 'Write the release notes',
      listName: 'In progress',
      position: 2,
      total: 2,
    });
  });

  it('over a card drops at that card index', () => {
    expect(targetOf(board(), 'c3', 'c1')).toEqual({
      title: 'Wire the presence bar',
      listName: 'Backlog',
      position: 1,
      total: 3,
    });
  });

  it('counts the destination after the move, not before', () => {
    // `Done` is empty. A card arriving there is "1 of 1", never "1 of 0".
    expect(targetOf(board(), 'c1', 'l3')).toMatchObject({ position: 1, total: 1 });
  });

  it('does not inflate the count when the card is already in that list', () => {
    // Reordering inside Backlog: two cards before, two cards after. Adding one
    // here would announce a card that does not exist.
    expect(targetOf(board(), 'c1', 'c2')).toMatchObject({ position: 2, total: 2 });
  });

  it('is null when there is no target', () => {
    expect(targetOf(board(), 'c1', null)).toBeNull();
    expect(targetOf(board(), 'c1', 'nowhere')).toBeNull();
  });
});

describe('the sentences a screen reader hears', () => {
  it('names the card on pick-up, never its id', () => {
    const message = pickedUpMessage(board(), 'c1');
    expect(message).toBe(
      'Picked up Write the release notes, in Backlog, 1 of 2. Use the arrow keys to move it, space to drop it, escape to put it back.',
    );
    // The regression this file exists for: @dnd-kit's own default announces
    // `active.id`, and every id here is a cuid.
    expect(message).not.toContain('c1');
  });

  it('names the destination while moving over it', () => {
    expect(movedOverMessage(board(), 'c1', 'l3')).toBe(
      'Write the release notes is over Done, 1 of 1.',
    );
  });

  it('confirms the drop with where it landed', () => {
    expect(droppedMessage(board(), 'c1', 'l2')).toBe(
      'Dropped Write the release notes into In progress, 2 of 2.',
    );
  });

  it('says the card stayed put when it is released over nothing', () => {
    // Silence here is indistinguishable from a move that failed, and the card
    // really has not moved, so the sentence has to say both.
    expect(droppedMessage(board(), 'c1', null)).toBe(
      'Dropped Write the release notes. It stayed in Backlog, 1 of 2.',
    );
  });

  it('says where the card went back to on escape', () => {
    expect(cancelledMessage(board(), 'c2')).toBe(
      'Cancelled. Cut the 1.0 tag is back in Backlog, 2 of 2.',
    );
  });

  it('returns undefined rather than a sentence about nothing', () => {
    // `undefined` is @dnd-kit's "announce nothing". An empty string would be
    // announced, as a pause.
    expect(pickedUpMessage(board(), 'gone')).toBeUndefined();
    expect(movedOverMessage(board(), 'c1', null)).toBeUndefined();
    expect(droppedMessage(board(), 'gone', null)).toBeUndefined();
    expect(cancelledMessage(board(), 'gone')).toBeUndefined();
  });
});
