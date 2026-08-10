import { realtimeHealthSchema, type RealtimeHealth } from '@kan/shared';
import type { Metadata } from 'next';

import { apiBaseUrl, realtimeBaseUrl, realtimeReplicaUrl } from '../../../lib/config';

export const metadata: Metadata = { title: 'Status' };

// Nothing here may be cached: a health check served from a cache is a health
// check that reports the state of a previous request.
export const dynamic = 'force-dynamic';

/**
 * Every process this app depends on, and what each one says about itself.
 *
 * The page is fed by the same `/health` endpoints the Docker HEALTHCHECKs and
 * `scripts/dev-smoke.sh` read, so there is one definition of healthy rather than
 * a dashboard that agrees with nothing.
 *
 * **Both gateway replicas are probed, not one.** "The gateway is up" is the wrong
 * question for a process whose entire point is that there are several of it: one
 * replica green and one red produces this product's worst symptom -- half the
 * people on a board see each other and half do not -- and it is invisible to a
 * page that only asks whichever replica it happens to reach.
 *
 * The gateway's own check does strictly more than the API's: it round-trips a
 * nonce through the Socket.io adapter's two Redis connections, because a gateway
 * whose pub/sub is dead still answers every socket it holds and silently stops
 * relaying to the others.
 */
interface Probe {
  name: string;
  url: string;
  /** Null when the process did not answer at all. */
  health: RealtimeHealth | null;
  error: string | null;
}

async function probe(name: string, base: string): Promise<Probe> {
  try {
    const response = await fetch(`${base}/health`, {
      cache: 'no-store',
      // Longer than the endpoint's own 2s per-dependency timeout, so a slow
      // dependency is reported by the service rather than swallowed as a timeout
      // here -- which would lose the detail saying which dependency was slow.
      signal: AbortSignal.timeout(6_000),
    });
    const body: unknown = await response.json();
    const parsed = realtimeHealthSchema.safeParse(body);
    if (!parsed.success) {
      return { name, url: base, health: null, error: 'answered something this page cannot read' };
    }
    return { name, url: base, health: parsed.data, error: null };
  } catch (error) {
    return {
      name,
      url: base,
      health: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export default async function StatusPage(): Promise<JSX.Element> {
  const primary = realtimeBaseUrl();
  const replica = realtimeReplicaUrl();
  // Only when it is genuinely a second process. Some lanes point
  // REALTIME_BASE_URL_2 at the primary so the variable is always defined, and
  // probing one process twice renders two identical rows -- which reads as two
  // healthy replicas when there is one.
  const secondReplica = replica && replica !== primary ? replica : null;

  const probes = await Promise.all([
    probe('API', apiBaseUrl()),
    probe('Realtime gateway', primary),
    ...(secondReplica ? [probe('Realtime gateway (replica)', secondReplica)] : []),
  ]);

  return (
    <div className="page-narrow">
      <div className="page-head">
        <div className="grow">
          <h1>Status</h1>
          <p className="lede">
            The same <code>/health</code> endpoints the containers and the smoke test read. Each one
            checks its dependencies for real rather than reporting that its own process is running.
          </p>
        </div>
      </div>

      <div className="stack">
        {probes.map((entry) => (
          <section key={entry.name} className="panel">
            <div className="spread">
              <h2>{entry.name}</h2>
              <span className={entry.health?.status === 'ok' ? 'status-ok' : 'status-fail'}>
                {/* The word, not a colour: --ok and --wip-over are 1.12:1 apart
                    in greyscale. */}
                {entry.health ? entry.health.status : 'unreachable'}
              </span>
            </div>

            <p className="lede">
              <code>{entry.url}/health</code>
              {entry.health && (
                <>
                  {' · version '}
                  <span className="num">{entry.health.version}</span>
                  {' · up '}
                  <span className="num">{entry.health.uptimeSeconds}</span>s
                  {entry.health.connectedSockets !== undefined && (
                    <>
                      {' · '}
                      <span className="num">{entry.health.connectedSockets}</span> sockets in{' '}
                      <span className="num">{entry.health.rooms ?? 0}</span> boards
                    </>
                  )}
                </>
              )}
            </p>

            {entry.error && <p className="notice notice-error">! {entry.error}</p>}

            {entry.health && (
              <table className="table">
                <caption className="visually-hidden">Dependency checks for {entry.name}</caption>
                <thead>
                  <tr>
                    <th scope="col">Dependency</th>
                    <th scope="col">State</th>
                    <th scope="col">Latency</th>
                    <th scope="col">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.health.checks.map((check) => (
                    <tr key={check.name}>
                      <th scope="row">{check.name}</th>
                      <td className={check.status === 'ok' ? 'status-ok' : 'status-fail'}>
                        {check.status}
                      </td>
                      <td className="num">{check.latencyMs}ms</td>
                      <td className="muted">{check.detail ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
