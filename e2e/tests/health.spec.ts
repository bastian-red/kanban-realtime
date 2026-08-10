import { expect, test } from '@playwright/test';

import { apiBaseUrl } from '../playwright.config';
import { signIn } from '../fixtures/app';
import { ANA } from '../fixtures/seed-facts';

const realtimeBaseUrl = process.env.REALTIME_BASE_URL ?? 'http://localhost:4100';

/**
 * The health endpoints, and the /status page that renders them.
 *
 * Nothing in this project is deployed, so "it is operable" has to be demonstrated
 * inside the repo. These endpoints are that demonstration, and they are exercised
 * here rather than only by a Dockerfile's HEALTHCHECK -- a check that only runs
 * inside a container nobody starts is a check nobody runs.
 *
 * The gateway's is the interesting one: it round-trips a nonce through the
 * Socket.io adapter's own two Redis connections, because a gateway whose pub/sub
 * is dead still answers every socket it holds and silently stops relaying to the
 * other replicas. A liveness probe reports green through the entire outage.
 */
test.describe('/health', () => {
  test('the API checks Postgres and Redis for real', async ({ request }) => {
    const response = await request.get(`${apiBaseUrl}/health`);
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.status).toBe('ok');
    // Named dependencies, each with its own latency. "Which one" is the first
    // question anybody asks, and a bare boolean does not answer it.
    const names = body.checks.map((check: { name: string }) => check.name);
    expect(names).toEqual(expect.arrayContaining(['postgres', 'redis']));
    for (const check of body.checks) {
      expect(check.status).toBe('ok');
      expect(typeof check.latencyMs).toBe('number');
    }
  });

  test('the gateway round-trips the adapter, not just a Redis ping', async ({ request }) => {
    const response = await request.get(`${realtimeBaseUrl}/health`);
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.status).toBe('ok');
    const names = body.checks.map((check: { name: string }) => check.name);
    // `adapter` is the check that separates this endpoint from a liveness probe.
    expect(names).toEqual(expect.arrayContaining(['postgres', 'redis', 'adapter']));
    expect(body.checks.find((check: { name: string }) => check.name === 'adapter').status).toBe(
      'ok',
    );
    // And the counts that make a green tick diagnosable.
    expect(typeof body.connectedSockets).toBe('number');
  });

  test('both endpoints answer without a session', async ({ request }) => {
    // They are `@Public()`. A health check behind auth is a health check a monitor
    // cannot read, which defeats the point.
    for (const url of [`${apiBaseUrl}/health`, `${realtimeBaseUrl}/health`]) {
      expect((await request.get(url)).status()).toBe(200);
    }
  });
});

test.describe('/status', () => {
  test('renders every service and its dependency checks', async ({ page }) => {
    await signIn(page, ANA.email);
    await page.getByRole('link', { name: 'Status' }).click();

    await expect(page.getByRole('heading', { name: 'Status', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'API' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Realtime gateway', exact: true }),
    ).toBeVisible();

    // The dependency names come from the services' own /health bodies, so their
    // presence proves the page fetched and parsed them rather than rendering a
    // shell. An unreachable service renders "unreachable" and no table.
    await expect(page.getByRole('rowheader', { name: 'postgres' }).first()).toBeVisible();
    await expect(page.getByRole('rowheader', { name: 'adapter' })).toBeVisible();
  });

  test('says "ok" in words rather than only in colour', async ({ page }) => {
    // `--ok` and `--wip-over` separate by 1.12:1 in greyscale. The word is the
    // signal; the colour is the reinforcement.
    await signIn(page, ANA.email);
    await page.goto('/status');
    await expect(page.getByText('ok', { exact: true }).first()).toBeVisible();
  });
});
