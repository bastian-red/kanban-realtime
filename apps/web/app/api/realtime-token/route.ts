import { NextResponse } from 'next/server';

import { currentUser, tokenFor } from '../../../lib/session';

/**
 * A fresh service token for the socket handshake.
 *
 * The browser cannot mint one: `AUTH_SECRET` never leaves the server, and a
 * client bundle that could sign a token could sign one for any user id. So the
 * session cookie is exchanged here for a short-lived HS256 token, which is the
 * same token the REST client carries and the same one the gateway verifies.
 *
 * **It is a route rather than a prop, and that is the reconnection story.** The
 * token lives two minutes. Handing one down from the server component works for
 * the first connect and then quietly stops working: a board left open over lunch
 * reconnects with a token that expired forty minutes ago, the handshake is
 * refused, and Socket.io retries with the same dead credential forever. The
 * client asks this route on **every** connection attempt instead, so a reconnect
 * always carries a live token.
 *
 * `no-store`, because a cached bearer credential is one user's token served to
 * the next visitor.
 */
export async function GET(): Promise<NextResponse> {
  const user = await currentUser();
  // 401 rather than a redirect: the caller is `fetch` from a socket handshake,
  // and an HTML login page arriving where JSON was expected produces a parse
  // error instead of a reason.
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  return NextResponse.json({ token: tokenFor(user) }, { headers: { 'cache-control': 'no-store' } });
}
