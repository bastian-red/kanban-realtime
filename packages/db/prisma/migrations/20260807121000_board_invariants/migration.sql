-- Invariants Prisma's schema language cannot express.
--
-- Every constraint here exists because application code alone would let a
-- specific bad state reach the database. They are the last line of defence, not
-- the first: services/board-ops is supposed to make them unreachable, so a
-- violation surfacing at runtime means there is a bug to fix rather than a case
-- to swallow -- with one deliberate exception, the position collision in section
-- 1, which is *expected* under concurrency and is what the retry loop is built
-- on.
--
-- The names are exported from `packages/db/src/index.ts`, because code that
-- catches a violation must match on the constraint name and never on the message
-- text, which Postgres localises and rewords between versions.

-- ---------------------------------------------------------------------------
-- 1. A position is a non-empty base62 fractional index.
--
-- This is the constraint the whole ordering design rests on, and it is the one
-- whose absence is hardest to notice.
--
-- A position is a *string* that sorts: 'a0' < 'a0V' < 'a1'. The unique index on
-- (list_id, position) is already declared by Prisma's @@unique, and it is what
-- makes a collision observable -- two clients dropping a card into the same gap
-- in the same millisecond get 23505 on the second insert, which
-- services/board-ops catches, re-jitters, and retries. Without the index the
-- second write succeeds, two cards share a position, and the board's order
-- becomes whatever the query planner produced that day: not an error anywhere,
-- and wrong everywhere.
--
-- The CHECK is the other half. An empty string is a perfectly good text value and
-- sorts before every real key, so a bug that wrote '' would put a card at the top
-- of its list forever with nothing to report. A key with punctuation in it sorts
-- by ASCII against keys that do not, which silently breaks the ordering the
-- generator promises. Both are rejected at the column so they cannot arrive
-- through a path that skipped the zod schema.
ALTER TABLE "cards"
  ADD CONSTRAINT "cards_position_format"
  CHECK ("position" ~ '^[a-zA-Z0-9]+$');

ALTER TABLE "lists"
  ADD CONSTRAINT "lists_position_format"
  CHECK ("position" ~ '^[a-zA-Z0-9]+$');

-- A ceiling, so a pathological insert loop cannot grow an unbounded key inside a
-- hot index. Keys grow by roughly one character each time a card is dropped into
-- the same gap; at 200 the ordering is still correct but something upstream is
-- wrong. Matches `positionSchema` in packages/shared.
ALTER TABLE "cards"
  ADD CONSTRAINT "cards_position_bounded"
  CHECK (length("position") <= 200);

ALTER TABLE "lists"
  ADD CONSTRAINT "lists_position_bounded"
  CHECK (length("position") <= 200);

-- ---------------------------------------------------------------------------
-- 2. A WIP limit is a limit, not a closure.
--
-- Null means no limit. Zero would mean a list nothing may ever enter, which is
-- not a limit -- it is an archived list, and the product has archiving for that.
-- A zero also makes "5 of 0" the label on a full column and divides by zero in
-- the fill percentage.
ALTER TABLE "lists"
  ADD CONSTRAINT "lists_wip_limit_positive"
  CHECK ("wip_limit" IS NULL OR "wip_limit" > 0);

-- ---------------------------------------------------------------------------
-- 3. A board has exactly one owner.
--
-- A partial unique index, which is the only way to say "at most one row per
-- board where role = OWNER" in Postgres. Prisma cannot express a WHERE on a
-- unique index, so it lives here.
--
-- Why it matters: there is no `owner_id` column on `boards` (see the note in
-- schema.prisma). The owner *is* the membership with role = OWNER, so "who may
-- delete this board" is a query, and a query with two answers is a permission
-- check that depends on row order. Two owners also make ownership transfer
-- unobservable -- nothing would fail, and the old owner would silently keep every
-- capability.
--
-- "At most one" is what an index can enforce. "At least one" is enforced by the
-- creation path, which writes the board and its OWNER membership in one
-- transaction, and by the delete path, which refuses to remove the last owner.
CREATE UNIQUE INDEX "board_members_one_owner_per_board"
  ON "board_members" ("board_id")
  WHERE "role" = 'OWNER';

-- ---------------------------------------------------------------------------
-- 4. Names are not blank.
--
-- A zero-length title renders as an empty card that cannot be clicked, read out,
-- or found by search: it is present in the data and absent from the interface.
-- The zod schemas already require min(1); this is the same rule at the one layer
-- that every write must pass through.
--
-- `btrim` rather than `length`, because a title of three spaces is blank to every
-- reader and non-empty to `length`.
ALTER TABLE "cards"
  ADD CONSTRAINT "cards_title_not_blank"
  CHECK (btrim("title") <> '');

ALTER TABLE "lists"
  ADD CONSTRAINT "lists_name_not_blank"
  CHECK (btrim("name") <> '');

ALTER TABLE "boards"
  ADD CONSTRAINT "boards_name_not_blank"
  CHECK (btrim("name") <> '');

-- ---------------------------------------------------------------------------
-- 5. The optimistic lock counts up.
--
-- `version` is the card's optimistic lock: every mutation carries the version the
-- client believes it is editing, and a mismatch is rejected with STALE. A
-- negative version cannot be produced by the increment path, so this catches a
-- write that set it directly -- at which point every in-flight client's
-- expectedVersion comparison is against a number that means nothing.
ALTER TABLE "cards"
  ADD CONSTRAINT "cards_version_non_negative"
  CHECK ("version" >= 0);

-- ---------------------------------------------------------------------------
-- 6. A label's colour slot is inside the palette.
--
-- Slots index a palette declared in the stylesheet, not hex colours (see the note
-- on Label in schema.prisma). A slot outside the range renders an undeclared CSS
-- custom property, and an undeclared property inside `calc()` invalidates the
-- whole declaration -- so the label would lose its colour *and* whatever else the
-- rule was setting, silently, in one colour scheme and not the other.
ALTER TABLE "labels"
  ADD CONSTRAINT "labels_color_slot_in_palette"
  CHECK ("color_slot" >= 0 AND "color_slot" <= 7);

-- ---------------------------------------------------------------------------
-- 7. The activity feed reads newest-first, per board, by cursor.
--
-- Prisma declares `@@index([boardId, createdAt(sort: Desc)])`, which this
-- migration inherits. What Prisma cannot declare is the tie-break: two activity
-- rows written in the same transaction share a `created_at` to microsecond
-- precision, and a cursor that pages on `created_at` alone will either repeat a
-- row or skip one at the page boundary. The feed therefore orders by
-- (created_at DESC, id DESC), and this index is what makes that ordering an index
-- scan rather than a sort.
CREATE INDEX "activities_board_created_id_desc"
  ON "activities" ("board_id", "created_at" DESC, "id" DESC);
