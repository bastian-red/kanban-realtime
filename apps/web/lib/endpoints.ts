import { toQueryString } from './query';

/**
 * Every path this app asks `apps/api` for, in one file.
 *
 * The shapes that cross the wire are frozen in
 * `packages/shared/src/contracts/index.ts` and both sides import them. The
 * *paths* are not in that file, because a URL is not a type and putting strings
 * in the contract would mean a route rename is a contract change. So they live
 * here instead, as one table, for one reason: the web app and the API are built
 * by two people at once, and a path that turns out to be wrong is then a one-line
 * fix in a file whose whole job is that list, rather than a grep across twenty
 * server components.
 *
 * The socket protocol is the other half of this app's surface and is deliberately
 * **not** here: its event names are constants in `@kan/shared`, because a socket
 * listener for an event nobody emits is silent, and eslint refuses a hand-typed
 * one in `e2e/`.
 *
 * Ids are percent-encoded even though they are cuids, because "the id is always
 * URL-safe" is an assumption about a column that nothing in the contract
 * enforces.
 */

const id = (value: string): string => encodeURIComponent(value);

export const endpoints = {
  /** Anonymous. The only two calls that carry no bearer token. */
  login: '/auth/login',
  signup: '/auth/signup',

  boards: '/boards',
  board: (boardId: string): string => `/boards/${id(boardId)}`,
  boardMembers: (boardId: string): string => `/boards/${id(boardId)}/members`,
  boardMember: (boardId: string, userId: string): string =>
    `/boards/${id(boardId)}/members/${id(userId)}`,

  activity: (boardId: string, query: { cursor?: string; limit?: number } = {}): string =>
    `/boards/${id(boardId)}/activity${toQueryString({ cursor: query.cursor, limit: query.limit })}`,

  lists: (boardId: string): string => `/boards/${id(boardId)}/lists`,
  list: (boardId: string, listId: string): string => `/boards/${id(boardId)}/lists/${id(listId)}`,
  /** Verb segments, because neither is a CRUD verb. */
  listMove: (boardId: string, listId: string): string =>
    `/boards/${id(boardId)}/lists/${id(listId)}/move`,
  listArchive: (boardId: string, listId: string): string =>
    `/boards/${id(boardId)}/lists/${id(listId)}/archive`,

  cards: (boardId: string): string => `/boards/${id(boardId)}/cards`,
  card: (boardId: string, cardId: string): string => `/boards/${id(boardId)}/cards/${id(cardId)}`,
  cardMove: (boardId: string, cardId: string): string =>
    `/boards/${id(boardId)}/cards/${id(cardId)}/move`,
  cardArchive: (boardId: string, cardId: string): string =>
    `/boards/${id(boardId)}/cards/${id(cardId)}/archive`,

  health: '/health',
} as const;
