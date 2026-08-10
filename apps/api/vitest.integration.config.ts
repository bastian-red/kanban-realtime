import { defineConfig } from 'vitest/config';

// Integration lane: needs a real Postgres, a real Redis, and two real gateway
// processes (started by scripts/integration.sh). These tests are the proof of
// every property the README claims -- concurrent drops into one gap, the
// optimistic lock, cross-replica broadcast, presence expiry -- so they run
// against real infrastructure rather than mocks. A mocked Postgres cannot refuse
// a duplicate position, and a single in-process Socket.io server cannot fail to
// broadcast across replicas.
//
// Serial by design: the files share one seeded board, and the concurrency test
// deliberately races twenty writers into one gap, so a second file running at the
// same time would make its assertions non-deterministic.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
