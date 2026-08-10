import { describe, expect, it } from 'vitest';

import { toCardRow, toListRow, type RawCard, type RawList } from './rows';

const CREATED = new Date('2026-08-01T09:00:00.000Z');
const UPDATED = new Date('2026-08-02T09:00:00.000Z');

const rawCard = (overrides: Partial<RawCard> = {}): RawCard => ({
  id: 'card-1',
  list_id: 'list-1',
  title: 'Fix login',
  description: null,
  position: 'a0',
  version: 3,
  due_on: null,
  assignee_id: null,
  archived_at: null,
  created_at: CREATED,
  updated_at: UPDATED,
  ...overrides,
});

const rawList = (overrides: Partial<RawList> = {}): RawList => ({
  id: 'list-1',
  board_id: 'board-1',
  name: 'Doing',
  position: 'a0',
  wip_limit: null,
  archived_at: null,
  ...overrides,
});

describe('toCardRow', () => {
  it('renames every snake_case column to the port’s field', () => {
    expect(toCardRow(rawCard())).toEqual({
      id: 'card-1',
      listId: 'list-1',
      title: 'Fix login',
      description: null,
      position: 'a0',
      version: 3,
      dueOn: null,
      assigneeId: null,
      archivedAt: null,
      createdAt: CREATED,
      updatedAt: UPDATED,
    });
  });

  it('narrows a bigint version to a number', () => {
    // The whole reason this function exists rather than a cast. `10n === 10` is
    // false, so an optimistic lock comparing a BigInt against `expectedVersion`
    // rejects every edit as STALE and nothing in the schema says why.
    const row = toCardRow(rawCard({ version: 10n }));
    expect(row.version).toBe(10);
    expect(row.version === 10).toBe(true);
  });

  it('keeps the dates as Date objects rather than strings', () => {
    // `dueOn` is a `date` column and the contract renders it as a calendar day
    // downstream. Turning it into a string here would move that decision into the
    // adapter, where the read path and the write path would each make it once.
    const row = toCardRow(rawCard({ due_on: new Date('2026-09-01T00:00:00.000Z') }));
    expect(row.dueOn).toBeInstanceOf(Date);
    expect(row.dueOn?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('toListRow', () => {
  it('renames every snake_case column to the port’s field', () => {
    expect(toListRow(rawList({ wip_limit: 4 }))).toEqual({
      id: 'list-1',
      boardId: 'board-1',
      name: 'Doing',
      position: 'a0',
      wipLimit: 4,
      archivedAt: null,
    });
  });

  it('keeps a null WIP limit null instead of turning it into zero', () => {
    // `Number(null)` is 0, and a limit of 0 is a list nothing may enter -- which
    // `lists_wip_limit_positive` refuses outright. "No limit" silently becoming
    // "limit zero" would make every card creation fail with a CHECK violation on
    // a list nobody configured.
    expect(toListRow(rawList({ wip_limit: null })).wipLimit).toBeNull();
  });

  it('narrows a bigint WIP limit to a number', () => {
    expect(toListRow(rawList({ wip_limit: 4n })).wipLimit).toBe(4);
  });
});
