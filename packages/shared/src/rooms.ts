/**
 * Socket.io room names.
 *
 * One function, shared, because **three processes have to agree on this string
 * and none of them can see the others**. The gateway puts a socket into a room on
 * `board.join`; the gateway broadcasts into it after a socket-driven write; the
 * REST API broadcasts into it, from a different process entirely, through the
 * Redis emitter. A hand-written `` `board:${id}` `` in any one of them that drifts
 * by a character produces no error anywhere: the write succeeds, the emit
 * succeeds, and the message is delivered to a room nobody is in.
 *
 * That is the worst failure shape in this whole codebase, because every layer
 * reports success and the only symptom is a board that does not move for the
 * other person -- which is indistinguishable, from the outside, from the socket
 * being down.
 *
 * The prefix is spelled out rather than templated from a constant so a reader
 * searching Redis with `PUBSUB CHANNELS` finds the same characters they read
 * here.
 */

/** The room every member of one board is in while they have it open. */
export function boardRoom(boardId: string): string {
  return `board:${boardId}`;
}

/**
 * The board a room name refers to, or null when the name is not a board room.
 *
 * Socket.io puts every socket in a room named after its own id, so iterating a
 * socket's rooms without this filter finds the socket id and treats it as a board.
 * Returning null rather than stripping a prefix blindly is what keeps that from
 * becoming a presence entry against a board called `abc123XYZ`.
 */
export function boardIdFromRoom(room: string): string | null {
  return room.startsWith('board:') ? room.slice('board:'.length) || null : null;
}
