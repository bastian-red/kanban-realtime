import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  boundsFor,
  firstKey,
  isPosition,
  keyBetween,
  keysBetween,
  needsRebalance,
  OrderingError,
  POSITION_PATTERN,
  type Positioned,
  REBALANCE_LENGTH,
  rebalance,
  sortByPosition,
} from './index';

/**
 * A seeded generator, so a failure is reproducible.
 *
 * `Math.random()` in a property test gives a failure nobody can reproduce: the
 * seed that broke it is gone the moment the process exits. Mulberry32 is four
 * lines and turns "it failed once on CI" into "run it with seed 12345".
 *
 * The jitter inside the library still uses `Math.random()`, and that is fine --
 * the properties asserted below hold for *every* jitter value, so the test does
 * not need to control it. What the seed controls is the shape of the workload:
 * which gap each insert targets.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('the dependency can be require()d', () => {
  it('loads under CommonJS, not only under ESM', () => {
    /**
     * The failure this exists for is a boot crash, not a test failure.
     *
     * Every package in this workspace compiles to CommonJS (`module: Node16` in
     * packages/config/tsconfig.node.json, no `"type": "module"` anywhere), so
     * `apps/api` and `apps/realtime` reach this module through `require()`.
     *
     * How much that matters depends on the Node version, and the honest version
     * of this note is narrower than it first appears. Requiring an ESM-only
     * package used to throw `ERR_REQUIRE_ESM` outright; `require(esm)` was
     * backported to the 20.x line in 20.19, so on the Node this repo actually
     * runs (measured: v20.19.2 requires `fractional-indexing@4`, an ESM-only
     * package, without complaint) it would not throw at all. The exposure is the
     * band this repo still declares support for: `engines.node: ">=20"` admits
     * 20.0 through 20.18, where it does throw, and it throws at first import
     * rather than at build -- `tsc` is happy, the types resolve, the image builds,
     * and then two processes die with an error about module systems rather than
     * about ordering.
     *
     * So this is a cheap guard over a narrow band rather than the load-bearing
     * check the design notes originally assumed. It is kept because it also
     * asserts the export actually exists, which is the thing that would break if
     * the dependency were swapped or upgraded, and because it costs one child
     * process.
     *
     * That child process is the point of `execFileSync`: vitest transforms this
     * file and resolves its imports through Vite, which happily loads ESM either
     * way, so an in-process check would pass against a package a plain Node
     * `require` could not load. Asking a bare `node` is the only way to ask the
     * real question.
     */
    const output = execFileSync(
      process.execPath,
      [
        '-e',
        'const m = require("fractional-indexing-jittered");' +
          'if (typeof m.generateJitteredKeyBetween !== "function") throw new Error("no jitter export");' +
          'process.stdout.write("ok");',
      ],
      { cwd: __dirname, encoding: 'utf8' },
    );
    expect(output).toBe('ok');
  });
});

describe('a position is a base62 string', () => {
  it('accepts what the database accepts', () => {
    for (const value of ['a0', 'a1', 'Zz', 'a0V', 'ZZZZZZZZ']) {
      expect(isPosition(value)).toBe(true);
      expect(POSITION_PATTERN.test(value)).toBe(true);
    }
  });

  it('rejects the empty string, which is the dangerous one', () => {
    // An empty key is a perfectly good text value that sorts before every real
    // key, so a bug that wrote one would pin a card to the top of its list
    // forever with nothing to report anywhere.
    expect(isPosition('')).toBe(false);
  });

  it.each([[' '], ['a 1'], ['a-1'], ['a.1'], ['a/1'], ['-1'], [null], [undefined], [3], [{}]])(
    'rejects %j',
    (value) => {
      expect(isPosition(value)).toBe(false);
    },
  );
});

describe('keyBetween', () => {
  it('produces a key strictly between its bounds', () => {
    const key = keyBetween('a0', 'a1');
    expect(key > 'a0').toBe(true);
    expect(key < 'a1').toBe(true);
  });

  it('handles an open lower bound, an open upper bound, and both', () => {
    expect(keyBetween(null, 'a1') < 'a1').toBe(true);
    expect(keyBetween('a1', null) > 'a1').toBe(true);
    expect(isPosition(keyBetween(null, null))).toBe(true);
  });

  it('always produces a key the database will accept', () => {
    for (let index = 0; index < 500; index += 1) {
      expect(POSITION_PATTERN.test(keyBetween('a0', 'a1'))).toBe(true);
    }
  });

  it('refuses bounds that are out of order rather than guessing', () => {
    // Backwards bounds mean the client's view of the list is stale: the two cards
    // it thinks are adjacent are not, or not in that order. Generating *some* key
    // would place the card where neither the caller nor the user asked.
    expect(() => keyBetween('a1', 'a0')).toThrow(OrderingError);
    expect(() => keyBetween('a1', 'a1')).toThrow(/ascending/);
  });

  it('refuses a malformed bound rather than passing it through', () => {
    expect(() => keyBetween('', 'a1')).toThrow(OrderingError);
    expect(() => keyBetween('a0', 'a 1')).toThrow(OrderingError);
    // The message has to say what is wrong with it, because the caller receiving
    // this is a socket handler with no other context.
    expect(() => keyBetween('a-0', null)).toThrow(/not a position/);
  });
});

describe('jitter is the whole point', () => {
  it('gives two clients dropping into the same gap two different keys', () => {
    // Without jitter both calls return the identical key, the second insert
    // violates UNIQUE (list_id, position), and one person's drag is rejected for
    // no reason they can see. This is the single assertion that would fail if
    // `generateJitteredKeyBetween` were swapped for `generateKeyBetween`, which
    // is exactly the revert test for this gate.
    const keys = new Set<string>();
    for (let index = 0; index < 2000; index += 1) keys.add(keyBetween('a0', 'a1'));
    expect(keys.size).toBeGreaterThan(1500);
  });

  it('keeps every jittered key inside the gap it was asked for', () => {
    // The subtle failure mode of hand-rolled jitter: appending random characters
    // to a key that is a prefix of the upper bound produces a key that sorts
    // AFTER the bound. It would pass "a0 < k" and break the order anyway.
    for (let index = 0; index < 2000; index += 1) {
      const key = keyBetween('a0', 'a1');
      expect(key > 'a0').toBe(true);
      expect(key < 'a1').toBe(true);
    }
  });

  it('jitters even in a gap it has to pad to fit into', () => {
    // Two adjacent keys with no room between them at the current length. The
    // library has to lengthen the key before it can jitter it; a version that
    // skipped the padding step would return the same key every time here.
    const lower = 'a0';
    const upper = keyBetween(lower, 'a1');
    const keys = new Set<string>();
    for (let index = 0; index < 500; index += 1) keys.add(keyBetween(lower, upper));
    expect(keys.size).toBeGreaterThan(1);
    for (const key of keys) {
      expect(key > lower).toBe(true);
      expect(key < upper).toBe(true);
    }
  });
});

describe('the property that matters: 10k interleaved inserts keep a total order', () => {
  /**
   * The workload this models is the real one: several people inserting into
   * random positions of the same list, over and over, forever. What must hold
   * afterwards is what the product promises -- every card has a distinct
   * position, and reading them back in key order gives the order they were placed
   * in.
   *
   * Run for three seeds rather than one. A single seed is a single workload
   * shape, and "always inserts at the end" is a shape that would hide every bug
   * about inserting in the middle.
   */
  it.each([1, 12345, 987_654_321])('holds for seed %i', (seed) => {
    const random = mulberry32(seed);
    const rounds = 10_000;

    // The list as the product sees it: an ordered array of keys. Kept sorted so
    // "insert at index i" means the same thing here as a drop between two cards.
    const keys: string[] = [firstKey()];

    for (let round = 0; round < rounds; round += 1) {
      const index = Math.floor(random() * (keys.length + 1));
      const lower = index === 0 ? null : keys[index - 1]!;
      const upper = index === keys.length ? null : keys[index]!;

      const key = keyBetween(lower, upper);

      // Asserted per insert, not only at the end, so a failure names the round
      // and the neighbours rather than reporting "the final array is wrong".
      if (lower !== null) expect(key > lower).toBe(true);
      if (upper !== null) expect(key < upper).toBe(true);

      keys.splice(index, 0, key);
    }

    expect(keys.length).toBe(rounds + 1);

    // No duplicates: every key is distinct, so UNIQUE (list_id, position) would
    // have accepted every one of these writes.
    expect(new Set(keys).size).toBe(keys.length);

    // The array was built by splicing at the chosen index, so it is in the order
    // the user placed the cards. Sorting it by key must not change it -- that is
    // the whole claim: the string order IS the visual order.
    expect(sortByPosition(keys.map((position) => ({ position })))).toEqual(
      keys.map((position) => ({ position })),
    );

    // Keys stay short. 10k inserts reached length 11 when this was measured; the
    // ceiling is generous so an implementation change that doubled growth still
    // passes, while one that grew a key per insert (the naive "append a char"
    // approach) would fail at around round 40.
    const longest = Math.max(...keys.map((key) => key.length));
    expect(longest).toBeLessThan(REBALANCE_LENGTH);
  });

  it('survives every insert landing in the same gap', () => {
    // The adversarial shape: a thousand people all dropping between the same two
    // cards. This is where key length grows fastest and where jitter collides
    // most often, and it is the shape a real board produces when everyone works
    // on the top of one column.
    const keys = ['a0', 'a1'];
    for (let round = 0; round < 1000; round += 1) {
      const key = keyBetween('a0', keys[1]!);
      expect(key > 'a0').toBe(true);
      expect(key < keys[1]!).toBe(true);
      keys.splice(1, 0, key);
    }
    expect(new Set(keys).size).toBe(keys.length);
    expect(sortByPosition(keys.map((position) => ({ position })))).toEqual(
      keys.map((position) => ({ position })),
    );
  });
});

describe('keysBetween', () => {
  it('returns ascending keys inside the bounds', () => {
    const keys = keysBetween('a0', 'a1', 5);
    expect(keys).toHaveLength(5);
    for (let index = 0; index < keys.length; index += 1) {
      expect(keys[index]! > 'a0').toBe(true);
      expect(keys[index]! < 'a1').toBe(true);
      if (index > 0) expect(keys[index]! > keys[index - 1]!).toBe(true);
    }
  });

  it('works with open bounds, which is what the seed uses', () => {
    const keys = keysBetween(null, null, 40);
    expect(keys).toHaveLength(40);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(40);
  });

  it('refuses a non-positive or fractional count', () => {
    expect(() => keysBetween(null, null, 0)).toThrow(OrderingError);
    expect(() => keysBetween(null, null, -1)).toThrow(OrderingError);
    expect(() => keysBetween(null, null, 2.5)).toThrow(OrderingError);
  });
});

describe('firstKey', () => {
  it('is deterministic, unlike every other generator here', () => {
    // The seed depends on this: scripts/seed-check.sh asserts two seed runs
    // produce an identical digest, and a jittered first key would break that at
    // the very first row. Safe because an empty list has no gap to share, which
    // is the only thing jitter protects against.
    expect(firstKey()).toBe(firstKey());
    expect(isPosition(firstKey())).toBe(true);
  });
});

describe('boundsFor', () => {
  const list: Positioned[] = [{ position: 'a1' }, { position: 'a3' }, { position: 'a2' }];

  it('sorts the list before reading its ends', () => {
    // The input above is deliberately out of order. A caller handing over rows
    // straight from a query with no ORDER BY is not a hypothetical.
    expect(boundsFor(list, null, null)).toEqual({ lower: null, upper: 'a1' });
  });

  it('reads a drop at the top as "before the first card"', () => {
    expect(boundsFor(list, null, 'a1')).toEqual({ lower: null, upper: 'a1' });
  });

  it('reads a drop at the bottom as "after the last card"', () => {
    expect(boundsFor(list, 'a3', null)).toEqual({ lower: 'a3', upper: null });
  });

  it('passes both neighbours through for a drop in the middle', () => {
    expect(boundsFor(list, 'a1', 'a2')).toEqual({ lower: 'a1', upper: 'a2' });
  });

  it('opens both ends only for a genuinely empty list', () => {
    expect(boundsFor([], null, null)).toEqual({ lower: null, upper: null });
  });

  it('bounds a both-null drop by the real first card, not by nothing', () => {
    // The concurrency case: two clients both send "put it at the top" while a
    // third card arrives between them. Returning { null, null } here would
    // generate a key with no relation to the list as it now is.
    const bounds = boundsFor(list, null, null);
    const key = keyBetween(bounds.lower, bounds.upper);
    expect(key < 'a1').toBe(true);
  });
});

describe('rebalance', () => {
  const grown: Positioned[] = [
    { position: 'a0' },
    { position: `a0${'V'.repeat(REBALANCE_LENGTH)}` },
    { position: 'a1' },
  ];

  it('reports a column whose keys have grown', () => {
    expect(needsRebalance([{ position: 'a0' }, { position: 'a1' }])).toBe(false);
    expect(needsRebalance(grown)).toBe(true);
  });

  it('returns one short key per item, in the same order', () => {
    const keys = rebalance(grown);
    expect(keys).toHaveLength(grown.length);
    expect([...keys].sort()).toEqual(keys);
    for (const key of keys) {
      expect(isPosition(key)).toBe(true);
      expect(key.length).toBeLessThan(REBALANCE_LENGTH);
    }
    expect(needsRebalance(keys.map((position) => ({ position })))).toBe(false);
  });

  it('is deterministic, because a rebalance has no concurrent writer', () => {
    // Even spacing is the entire point of the operation, and jitter would
    // reintroduce exactly the unevenness it exists to remove.
    expect(rebalance(grown)).toEqual(rebalance(grown));
  });

  it('handles an empty column', () => {
    expect(rebalance([])).toEqual([]);
  });
});

describe('sortByPosition', () => {
  it('does not mutate its input', () => {
    const input: Positioned[] = [{ position: 'a2' }, { position: 'a1' }];
    const sorted = sortByPosition(input);
    expect(input[0]!.position).toBe('a2');
    expect(sorted[0]!.position).toBe('a1');
  });

  it('orders by byte value, not by locale', () => {
    // `localeCompare` is allowed to treat case and accents by language rules, and
    // under some locales 'a' and 'A' compare equal -- which would make two
    // distinct keys sort unpredictably against each other. Postgres orders these
    // with the C collation, and the client has to agree with the database or the
    // board renders in a different order than it was stored in.
    const positions = ['a1', 'A1', 'Z0', 'z0', 'a0'];
    const sorted = sortByPosition(positions.map((position) => ({ position })));
    expect(sorted.map((item) => item.position)).toEqual([...positions].sort());
    // And concretely: uppercase sorts before lowercase in ASCII.
    expect(sorted[0]!.position).toBe('A1');
  });
});
