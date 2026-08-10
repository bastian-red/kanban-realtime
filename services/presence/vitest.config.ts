import { defineConfig } from 'vitest/config';

// Gate lane: everything runs against a small hash-only fake Redis, so the
// collapsing logic and the TTL arithmetic are tested instantly and without a
// server. That a key actually expires, and that two gateway replicas see one
// roster, is the integration lane's job. See the note above FakeRedis.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
