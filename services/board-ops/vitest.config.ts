import { defineConfig } from 'vitest/config';

// Gate lane: everything here runs against the in-memory repository, so it is
// deterministic, offline and fast. What this lane cannot see -- that Postgres
// actually refuses a duplicate position, and that two real transactions
// serialise -- is the integration lane's job. See memory-repository.ts.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
