#!/usr/bin/env bash
#
# Prove the seed is deterministic and idempotent, against a real database.
#
# Two properties, both of which everything downstream assumes and neither of
# which a unit test can see:
#
#   deterministic - two runs produce the same board. The E2E suite drags a named
#                   card out of a named list at a known rank, and the README
#                   quotes those names; a generator that drifts turns those into
#                   flaky failures that look like product bugs.
#   idempotent    - running it twice leaves one board, not two. The seed deletes
#                   the demo users first and relies on the cascades; a missing
#                   `ON DELETE CASCADE` anywhere in the schema shows up here as a
#                   doubled row count and nowhere else.
#
# The digest covers content only: board name, list name, the card's rank inside
# its list, its title and its label set. Two things are deliberately excluded:
#
#   - Primary keys. They are cuids and differ on every run by design, so an id in
#     the digest would make this fail every time and teach nothing.
#   - The raw `position` string. Positions are JITTERED fractional indices
#     (services/ordering): the whole point of the jitter is that two calls asking
#     for a key in the same gap return different keys, which is what stops two
#     concurrent drags from colliding. So the key is random by construction and
#     the ORDER it encodes is what the product promises. The digest takes the
#     rank -- row_number() over the position ordering -- which is stable across
#     runs exactly when the seed is. Digesting the raw key instead would report
#     the seed as non-deterministic on every run and would have to be deleted,
#     taking the real cascade check with it.
#
#   ./scripts/seed-check.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

# `.env` when there is one, the environment otherwise, and .env.example's value
# as the last resort -- the same three-step shape scripts/integration.sh and
# scripts/e2e.sh use. This file used to require `.env` outright, which was fine
# locally and wrong on CI: the integration job hands DATABASE_URL in through the
# job's `env:` block and never writes a dotenv file, so the check exited 1 with
# one line of output before it read a single row. A lane that cannot run where it
# is meant to run is not a lane.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

export DATABASE_URL="${DATABASE_URL:-postgresql://kan:kan@localhost:5437/kan?schema=public}"

# Prisma's URL carries `?schema=public`, which libpq rejects outright.
PSQL_URL="${DATABASE_URL%%\?*}"

# The demo owner's email, read out of the seed rather than retyped, for the same
# reason scripts/dev-smoke.sh reads it: a copy that drifts produces a digest
# confidently computed over zero rows, which passes.
DEMO_EMAIL="$(sed -n "s/^const DEMO_EMAIL = '\([^']*\)';.*/\1/p" packages/db/prisma/seed.ts)"
[[ -n "$DEMO_EMAIL" ]] ||
  { echo "could not read DEMO_EMAIL out of packages/db/prisma/seed.ts." >&2; exit 1; }

# `string_agg` needs the ORDER BY: without it the row order is whatever the
# planner produced, and the digest changes between two identical boards.
read -r -d '' DIGEST_SQL <<'SQL_END' || true
SELECT count(*) || ' ' || coalesce(md5(string_agg(x, '|' ORDER BY x)), '-')
FROM (
  SELECT b.name || ':' || l.name || ':' || ranked.rank || ':' || ranked.title
         || ':' || coalesce(ranked.labels, '-') AS x
  FROM (
    SELECT c.id,
           c.list_id,
           c.title,
           row_number() OVER (PARTITION BY c.list_id ORDER BY c.position) AS rank,
           (SELECT string_agg(lb.name, ',' ORDER BY lb.name)
              FROM card_labels cl
              JOIN labels lb ON lb.id = cl.label_id
             WHERE cl.card_id = c.id) AS labels
    FROM cards c
  ) ranked
  JOIN lists l ON l.id = ranked.list_id
  JOIN boards b ON b.id = l.board_id
  -- The owner is a membership with role = OWNER, not a column on boards. The
  -- partial unique index in the board_invariants migration allows exactly one per
  -- board, so this join cannot fan out.
  JOIN board_members bm ON bm.board_id = b.id AND bm.role = 'OWNER'
  JOIN users u ON u.id = bm.user_id
  WHERE u.email = :'demo_email'
) board;
SQL_END

# The SQL goes in on stdin, not through --command, and that is not a style
# choice: psql performs variable interpolation on input it reads, and does NOT
# perform it on a string given with -c. With --command the `:'demo_email'` below
# reaches the server verbatim and Postgres answers
#
#   ERROR:  syntax error at or near ":"
#
# The alternative -- pasting the address straight into the SQL -- would work here
# and is how a seed value ends up concatenated into a query somewhere it matters.
# `--variable` plus stdin quotes and escapes it properly for nothing.
digest() {
  printf '%s\n' "$DIGEST_SQL" |
    psql "$PSQL_URL" --no-psqlrc --quiet --tuples-only --no-align \
      --variable "demo_email=${DEMO_EMAIL}"
}

# A second digest, because the first one cannot see the invariant that matters
# most to this project. Ranks are dense and unique by construction (row_number
# says so), so a duplicated position would still produce a tidy 1..n and pass.
# This asks Postgres directly whether any list holds two cards at one position --
# which the `UNIQUE (list_id, position)` index in the board_invariants migration
# is supposed to make impossible, and which is the constraint the whole
# concurrency story rests on.
read -r -d '' DUPLICATE_SQL <<'SQL_END' || true
SELECT coalesce(sum(n - 1), 0)
FROM (
  SELECT count(*) AS n FROM cards GROUP BY list_id, position HAVING count(*) > 1
) duplicates;
SQL_END

run_seed() {
  pnpm --filter @kan/db exec tsx prisma/seed.ts >/dev/null
}

echo "seed-check: first run"
run_seed
FIRST="$(digest)"
echo "  $FIRST"

echo "seed-check: second run"
run_seed
SECOND="$(digest)"
echo "  $SECOND"

if [[ "$FIRST" != "$SECOND" ]]; then
  echo >&2
  echo "FAIL: the seed is not deterministic or not idempotent." >&2
  echo "  run 1: $FIRST" >&2
  echo "  run 2: $SECOND" >&2
  echo "A changed card count means a cascade is missing; a changed digest with the" >&2
  echo "same count means something in the generator reads the clock or Math.random," >&2
  echo "or that two cards changed places." >&2
  exit 1
fi

if [[ "${FIRST%% *}" == "0" ]]; then
  echo "FAIL: the seed produced no cards." >&2
  exit 1
fi

DUPLICATES="$(printf '%s\n' "$DUPLICATE_SQL" |
  psql "$PSQL_URL" --no-psqlrc --quiet --tuples-only --no-align)"
if [[ "$DUPLICATES" != "0" ]]; then
  echo "FAIL: ${DUPLICATES} card(s) share a (list_id, position) with another card." >&2
  echo "The UNIQUE index from the board_invariants migration is missing or was dropped." >&2
  exit 1
fi

echo
echo "PASS: two runs, ${FIRST%% *} cards, identical content digest, no duplicate positions."
