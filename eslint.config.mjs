import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Flat config, linted from the repo root in a single pass (`pnpm lint`).
 * Deliberately not a per-package turbo task: one config, one resolution root,
 * no chance of a package silently linting with no rules at all.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      // Prisma's client. Machine-written, replaced on every `db:generate`, and
      // not something a lint rule has any business having an opinion about.
      'packages/db/generated/**',
      'next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // TypeScript already reports an undefined identifier, with full type
      // information. Leaving the lint rule on as well only produces false
      // positives on ambient and DOM globals.
      'no-undef': 'off',
    },
  },
  {
    /**
     * A fractional index is a string, and it is never compared as anything else.
     *
     * The whole ordering story of this app is that `position` is an opaque base62
     * key ordered by `<`, not a number: `parseFloat('a0') === NaN`, and
     * `'a1' < 'a0V'` is true while `1 < 0.5` is false. Coercing one to a number
     * to "sort properly" is the bug that turns a board into insertion order, and
     * it looks completely reasonable in review.
     *
     * `services/ordering` owns every operation on a position. These two rules
     * keep arithmetic out of it rather than merely discouraged.
     */
    files: ['services/ordering/src/**/*.ts'],
    rules: {
      'no-loss-of-precision': 'error',
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'A fractional index is a string, never a number.' },
        { name: 'parseInt', message: 'A fractional index is a string, never a number.' },
      ],
    },
  },
  {
    /**
     * No hand-typed socket event names in the E2E suite.
     *
     * The protocol is defined once, in `packages/shared/src/contracts/events.ts`,
     * and both the gateway and the browser client import those constants. A spec
     * that listens for `'card.moved'` as a literal keeps passing after the event
     * is renamed — it just waits for something that will never arrive and fails
     * on a timeout, forty lines from the rename that caused it.
     *
     * Scoped to `e2e/**` deliberately: the contract module itself is exactly
     * where those strings belong.
     */
    files: ['e2e/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // Every prefix the protocol uses, kept in step with CLIENT_EVENTS and
          // SERVER_EVENTS in packages/shared/src/contracts/events.ts. `server` is
          // in the list because the failure event is `server.error` rather than
          // the bare `error` Socket.io reserves, and `activity` because the feed
          // event is as easy to mistype as a card one.
          selector:
            'Literal[value=/^(board|card|list|presence|activity|member|server)\\.[a-z_]+$/]',
          message:
            'Do not hand-type a socket event name. Import it from @kan/shared: the protocol is ' +
            'defined once, and a literal here survives a rename as a timeout rather than a failure.',
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    /**
     * `consistent-type-imports` is off for the two Nest apps, and this is not a
     * style preference.
     *
     * NestJS resolves constructor dependencies from the type metadata that
     * `emitDecoratorMetadata` writes at compile time. An `import type` erases the
     * class entirely, so the metadata records `undefined` and Nest fails to inject
     * at runtime with an error that points nowhere near the import. The rule's
     * autofix will happily make that change across every service, and the result
     * compiles cleanly and dies at boot.
     */
    files: ['apps/api/src/**/*.ts', 'apps/realtime/src/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  {
    // Seeds, scripts and tests are allowed to talk to stdout.
    files: ['packages/db/prisma/**/*.ts', 'scripts/**/*.mjs', '**/*.test.ts', 'e2e/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.test.ts', 'apps/api/test/**/*.ts', 'apps/realtime/test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
