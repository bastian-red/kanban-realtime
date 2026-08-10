import { describe, expect, it } from 'vitest';

import {
  CARD_POSITION_UNIQUE,
  isCheckViolation,
  isConflict,
  isForeignKeyViolation,
  isNotFound,
  isPositionCollision,
  isUniqueViolation,
  LIST_POSITION_UNIQUE,
  BOARD_MEMBER_UNIQUE,
  CARD_POSITION_FORMAT,
} from './index';

/**
 * The error shapes below are not invented. They are what Prisma 5 and Postgres 16
 * actually produce, checked against the running database while writing this:
 * every constraint in `20260807121000_board_invariants` was tripped by hand and
 * the message and constraint name pasted from the output. The three shapes are:
 *
 *   1. Typed client, unique violation   -> code 'P2002', meta.target as an array
 *                                          of column names.
 *   2. Raw SQL                          -> SQLSTATE ('23505', '23514'),
 *                                          meta.constraint as the index name.
 *   3. Unknown request error            -> no `code` at all; the SQLSTATE is
 *                                          quoted inside the message text.
 *
 * A guard that handles only the first is the common mistake, and it is the one
 * that matters most here: `moveCard()`'s retry loop is built on recognising a
 * position collision, and a collision it fails to recognise becomes a 500 on the
 * exact path this project exists to handle gracefully.
 */

/** Shape 1: what `prisma.card.update()` throws when it trips the position index. */
const TYPED_POSITION_COLLISION = {
  code: 'P2002',
  message: 'Unique constraint failed on the fields: (`list_id`,`position`)',
  meta: { target: ['list_id', 'position'] },
};

/** Shape 1, for lists rather than cards. */
const TYPED_LIST_POSITION_COLLISION = {
  code: 'P2002',
  message: 'Unique constraint failed on the fields: (`board_id`,`position`)',
  meta: { target: ['board_id', 'position'] },
};

/** Shape 1, a different unique index entirely: adding somebody twice. */
const TYPED_MEMBER_DUPLICATE = {
  code: 'P2002',
  message: 'Unique constraint failed on the fields: (`board_id`,`user_id`)',
  meta: { target: ['board_id', 'user_id'] },
};

/** Shape 2: the same collision reached through $executeRaw. */
const RAW_POSITION_COLLISION = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "cards_list_id_position_key"',
  meta: { constraint: 'cards_list_id_position_key' },
};

/** Shape 2, a CHECK: exactly the message Postgres printed for a malformed key. */
const RAW_POSITION_FORMAT = {
  code: '23514',
  message: 'new row for relation "cards" violates check constraint "cards_position_format"',
  meta: { constraint: 'cards_position_format' },
};

/** Shape 3: no `code`, SQLSTATE buried in the connector's own text. */
const UNKNOWN_WRAPPED_CHECK = {
  message:
    'Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, ' +
    'kind: QueryError(PostgresError { code: "23514", message: "new row for relation \\"cards\\" violates ' +
    'check constraint \\"cards_position_format\\"", severity: "ERROR", detail: None, column: None, ' +
    'hint: None }), transient: false })',
};

describe('a position collision is recognised however it arrives', () => {
  it('through the typed client', () => {
    expect(isUniqueViolation(TYPED_POSITION_COLLISION)).toBe(true);
    expect(isUniqueViolation(TYPED_POSITION_COLLISION, CARD_POSITION_UNIQUE)).toBe(true);
    expect(isPositionCollision(TYPED_POSITION_COLLISION)).toBe(true);
  });

  it('through raw SQL', () => {
    expect(isUniqueViolation(RAW_POSITION_COLLISION, CARD_POSITION_UNIQUE)).toBe(true);
    expect(isPositionCollision(RAW_POSITION_COLLISION)).toBe(true);
  });

  it('for lists as well as cards', () => {
    expect(isUniqueViolation(TYPED_LIST_POSITION_COLLISION, LIST_POSITION_UNIQUE)).toBe(true);
    expect(isPositionCollision(TYPED_LIST_POSITION_COLLISION)).toBe(true);
  });
});

describe('a position collision is not confused with another unique index', () => {
  it('does not read a card collision as a list collision', () => {
    // The column-name matching in `matches()` is the risky part: 'list_id,position'
    // has to match cards_list_id_position_key and NOT lists_board_id_position_key.
    // If it matched both, a genuinely stuck list move would be retried under the
    // card rules and vice versa.
    expect(isUniqueViolation(TYPED_POSITION_COLLISION, LIST_POSITION_UNIQUE)).toBe(false);
    expect(isUniqueViolation(TYPED_LIST_POSITION_COLLISION, CARD_POSITION_UNIQUE)).toBe(false);
  });

  it('does not read a duplicate member as a position collision', () => {
    // This is the one that decides between retrying and reporting. Adding the
    // same person to a board twice is a conflict the user must be told about
    // immediately; re-jittering a key and trying again would loop to the attempt
    // ceiling and then report a conflict several hundred milliseconds late.
    expect(isUniqueViolation(TYPED_MEMBER_DUPLICATE)).toBe(true);
    expect(isUniqueViolation(TYPED_MEMBER_DUPLICATE, BOARD_MEMBER_UNIQUE)).toBe(true);
    expect(isPositionCollision(TYPED_MEMBER_DUPLICATE)).toBe(false);
  });
});

describe('check violations', () => {
  it('are recognised from raw SQL', () => {
    expect(isCheckViolation(RAW_POSITION_FORMAT)).toBe(true);
    expect(isCheckViolation(RAW_POSITION_FORMAT, CARD_POSITION_FORMAT)).toBe(true);
  });

  it('are recognised when the SQLSTATE is only inside the message', () => {
    // The shape with no `code` field at all. Reading the quoted SQLSTATE is not
    // the message-grepping this module warns against: `code: "23514"` is a
    // machine-written field name and a numeric code, not a localised sentence.
    expect(isCheckViolation(UNKNOWN_WRAPPED_CHECK)).toBe(true);
    expect(isCheckViolation(UNKNOWN_WRAPPED_CHECK, CARD_POSITION_FORMAT)).toBe(true);
  });

  it('are not unique violations', () => {
    // A malformed position is a bug in the caller and must surface as one. Being
    // caught by a retry loop would turn it into MOVE_RETRY_ATTEMPTS attempts at
    // writing the same invalid key, then a CONFLICT that blames concurrency.
    expect(isUniqueViolation(RAW_POSITION_FORMAT)).toBe(false);
    expect(isPositionCollision(RAW_POSITION_FORMAT)).toBe(false);
    expect(isConflict(RAW_POSITION_FORMAT)).toBe(false);
  });
});

describe('the other classifications', () => {
  it('recognises a foreign key violation', () => {
    // Concretely: deleting a user who authored activity. `Activity.actor` is
    // onDelete: Restrict, and this is the error the seed's teardown hit on its
    // second run before the delete order was fixed.
    expect(
      isForeignKeyViolation({
        code: 'P2003',
        message: 'Foreign key constraint violated: `activities_actor_id_fkey (index)`',
        meta: { field_name: 'activities_actor_id_fkey (index)' },
      }),
    ).toBe(true);
  });

  it('recognises a missing row', () => {
    expect(
      isNotFound({ code: 'P2025', message: 'An operation failed because it depends on...' }),
    ).toBe(true);
    expect(isNotFound(RAW_POSITION_COLLISION)).toBe(false);
  });

  it('treats every unique violation as a conflict, and nothing else', () => {
    expect(isConflict(TYPED_POSITION_COLLISION)).toBe(true);
    expect(isConflict(TYPED_MEMBER_DUPLICATE)).toBe(true);
    expect(isConflict(RAW_POSITION_FORMAT)).toBe(false);
  });
});

describe('nothing here throws on a value that is not an error', () => {
  it.each([[null], [undefined], ['a string'], [42], [[]], [{}]])('survives %j', (value) => {
    // These predicates run inside catch blocks. A guard that throws while
    // classifying replaces a recoverable collision with an unhandled rejection,
    // which on the gateway takes the socket down with it.
    expect(() => isUniqueViolation(value)).not.toThrow();
    expect(isUniqueViolation(value)).toBe(false);
    expect(isPositionCollision(value)).toBe(false);
    expect(isCheckViolation(value)).toBe(false);
    expect(isNotFound(value)).toBe(false);
    expect(isConflict(value)).toBe(false);
  });
});
