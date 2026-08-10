import { describe, expect, it } from 'vitest';

import { boardIdFromRoom, boardRoom } from './rooms';

describe('boardRoom', () => {
  it('names the room after the board', () => {
    expect(boardRoom('brd_123')).toBe('board:brd_123');
  });

  it('round-trips through boardIdFromRoom', () => {
    // The property that matters: the gateway joins with one function and the API
    // emits with the same one, so the only way they can disagree is if these two
    // stop being inverses.
    const id = 'clx0a1b2c3d4e5f6g7h8';
    expect(boardIdFromRoom(boardRoom(id))).toBe(id);
  });
});

describe('boardIdFromRoom', () => {
  it('rejects a room that is not a board room', () => {
    // Socket.io puts every socket in a room named after its own id. Iterating
    // `socket.rooms` without this filter would treat that id as a board and write
    // a presence entry against a board nobody opened.
    expect(boardIdFromRoom('kZ7pQ2mN4vB1xC9dAAAB')).toBeNull();
  });

  it('rejects the bare prefix with no id after it', () => {
    expect(boardIdFromRoom('board:')).toBeNull();
  });

  it('keeps a colon that is part of the id', () => {
    expect(boardIdFromRoom('board:a:b')).toBe('a:b');
  });
});
