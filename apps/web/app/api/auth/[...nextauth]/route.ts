import { handlers } from '../../../../auth';

/**
 * Auth.js's own routes.
 *
 * `handlers` is the `{ GET, POST }` pair NextAuth builds; re-exporting it is the
 * whole file. Everything about how a session is created lives in `auth.ts`.
 */
export const { GET, POST } = handlers;
