import { describe, expect, it } from 'vitest';

import {
  BOARD_OPERATIONS,
  BOARD_ROLES,
  type BoardOperation,
  type BoardRole,
  can,
  isBoardRole,
  operationsFor,
} from './roles';

/**
 * The permission matrix, written out a second time, on purpose.
 *
 * This is the one place in the repo where duplicating the implementation is the
 * point. `roles.ts` is a table, so a test that reads that table and asserts it
 * matches itself proves nothing at all -- it would pass with every cell flipped.
 * The grid below is the specification: it is what a reader of the README is being
 * told the product does, and any edit to `roles.ts` has to be made here too,
 * deliberately, in a diff someone reviews.
 *
 * `.` = refused, `x` = allowed.
 */
const EXPECTED: Record<BoardOperation, Record<BoardRole, boolean>> = {
  //                        OWNER  EDITOR VIEWER
  'board.read': { OWNER: true, EDITOR: true, VIEWER: true },
  'board.rename': { OWNER: true, EDITOR: false, VIEWER: false },
  'board.delete': { OWNER: true, EDITOR: false, VIEWER: false },
  'board.manageMembers': { OWNER: true, EDITOR: false, VIEWER: false },
  'list.create': { OWNER: true, EDITOR: true, VIEWER: false },
  'list.rename': { OWNER: true, EDITOR: true, VIEWER: false },
  'list.move': { OWNER: true, EDITOR: true, VIEWER: false },
  'list.archive': { OWNER: true, EDITOR: true, VIEWER: false },
  'card.create': { OWNER: true, EDITOR: true, VIEWER: false },
  'card.update': { OWNER: true, EDITOR: true, VIEWER: false },
  'card.move': { OWNER: true, EDITOR: true, VIEWER: false },
  'card.archive': { OWNER: true, EDITOR: true, VIEWER: false },
  'activity.read': { OWNER: true, EDITOR: true, VIEWER: true },
  'presence.join': { OWNER: true, EDITOR: true, VIEWER: true },
};

describe('the permission matrix', () => {
  // Three roles times fourteen operations, each asserted individually so a
  // failure names the exact cell rather than reporting "the matrix is wrong".
  for (const operation of BOARD_OPERATIONS) {
    for (const role of BOARD_ROLES) {
      const allowed = EXPECTED[operation][role];
      it(`${role} ${allowed ? 'may' : 'may not'} ${operation}`, () => {
        expect(can(role, operation)).toBe(allowed);
      });
    }
  }

  it('covers every operation the module exports', () => {
    // Without this, adding an operation to BOARD_OPERATIONS and forgetting it
    // here would leave it untested and silently denied to everyone -- or worse,
    // silently granted, if the new entry landed in the matrix but not the grid.
    expect(Object.keys(EXPECTED).sort()).toEqual([...BOARD_OPERATIONS].sort());
  });
});

describe('the shape of a denial', () => {
  it('refuses a non-member for every operation', () => {
    // `null` is what the board-ops repository returns for "this user has no
    // membership row", which is the state of a stranger following a shared link.
    for (const operation of BOARD_OPERATIONS) {
      expect(can(null, operation)).toBe(false);
    }
  });

  it('refuses undefined, which is what an unparsed session field looks like', () => {
    expect(can(undefined, 'board.read')).toBe(false);
  });

  it('refuses a role that is not a role, without throwing', () => {
    // A value read from an old JWT, a hand-edited request, or a database enum
    // that gained a member the code has not seen. It must be a denial, not a
    // TypeError inside a socket handler that would take the connection down.
    expect(can('ADMIN' as BoardRole, 'board.read')).toBe(false);
  });
});

describe('operationsFor', () => {
  it('agrees with can() for every role', () => {
    for (const role of BOARD_ROLES) {
      const listed = new Set(operationsFor(role));
      for (const operation of BOARD_OPERATIONS) {
        expect(listed.has(operation)).toBe(can(role, operation));
      }
    }
  });

  it('hands back a list a caller cannot use to grant itself more', () => {
    // The API sends this list to the client so the UI knows what to render. The
    // array it returns is the live table, not a copy, so if a caller could push
    // onto it one component's mistake would widen every later permission check in
    // the whole process. `Object.freeze` in roles.ts is what makes this throw;
    // these modules are ESM and therefore strict, so the write is not swallowed.
    const editor = operationsFor('EDITOR') as BoardOperation[];
    expect(() => editor.push('board.delete')).toThrow(TypeError);
    expect(can('EDITOR', 'board.delete')).toBe(false);
  });
});

describe('isBoardRole', () => {
  it('accepts the three real roles', () => {
    for (const role of BOARD_ROLES) expect(isBoardRole(role)).toBe(true);
  });

  it.each([['owner'], ['Owner'], [''], ['ADMIN']])('rejects %j', (value) => {
    // Case matters: these values are also the Postgres enum labels, and Postgres
    // enums are case-sensitive. A lowercase 'owner' that passed here would be
    // rejected by the database several layers later, as a 500.
    expect(isBoardRole(value)).toBe(false);
  });

  it.each([[null], [undefined], [42], [{}], [['OWNER']]])('rejects the non-string %j', (value) => {
    expect(isBoardRole(value)).toBe(false);
  });
});
