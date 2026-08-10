/**
 * Re-export of the operation type, so this service's internals do not each import
 * from `@kan/shared` for a single name.
 *
 * The matrix itself deliberately stays in `@kan/shared`: the web app needs it to
 * decide whether a card is draggable at all, and a permission table that lived
 * here would either be duplicated in the client or force the client to depend on
 * a server-side service.
 */
export type { BoardOperation, BoardRole } from '@kan/shared';
