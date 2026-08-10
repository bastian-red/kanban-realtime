/**
 * What `packages/db/prisma/seed.ts` plants, as the specs refer to it.
 *
 * One module rather than a string per spec. These names appear in a dozen
 * assertions, and a copy that drifts from the seed produces a check that is
 * confidently about data which no longer exists -- which is worse than no check,
 * because it reports green until somebody reads it.
 *
 * The seed is deliberately deterministic (see its header): the same boards, in
 * the same order, with the same names, on every run. That is what lets these be
 * constants instead of queries.
 */

/** Ana owns both boards. Every spec that needs to change something signs in as her. */
export const ANA = { email: 'ana@kanban.local', name: 'Ana Ruiz', initials: 'AR' } as const;

/** Bruno edits. Used as the *second* browser context in the live-sync specs. */
export const BRUNO = { email: 'bruno@kanban.local', name: 'Bruno Salas', initials: 'BS' } as const;

/** Carla views. She is how "a viewer cannot drag" is proven against a real role. */
export const CARLA = { email: 'carla@kanban.local', name: 'Carla Ortiz', initials: 'CO' } as const;

/** One password for every demo account. It is in the README; it is not a secret. */
export const PASSWORD = 'kanban-demo-2026';

export const BOARD = {
  name: 'Product launch',
  /** The four columns, in board order. */
  lists: ['Backlog', 'Ready', 'In progress', 'Done'],
} as const;

/** A card the specs drag. It starts in `In progress`. */
export const CARD = 'Wire the presence bar';

/** The second board, which Dan is on and Bruno is not. Proves "boards you can see". */
export const SECOND_BOARD = { name: 'Support rota' } as const;
