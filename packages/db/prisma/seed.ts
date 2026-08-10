/**
 * The demo boards.
 *
 * Two properties this file has to have, because three other things depend on
 * them:
 *
 *   deterministic - two runs produce the same boards, in the same order, with the
 *                   same names. The E2E suite drags a named card out of a named
 *                   list, `scripts/dev-smoke.sh` greps for a seeded board name,
 *                   and the README quotes them. Anything that reads the clock or
 *                   `Math.random()` here turns those into flaky failures that look
 *                   like product bugs.
 *   idempotent    - running it twice leaves one set of boards, not two. It deletes
 *                   the demo users first and lets `ON DELETE CASCADE` do the rest,
 *                   which is also what makes a missing cascade visible:
 *                   `scripts/seed-check.sh` runs this twice and compares a content
 *                   digest, so a board that survived its owner shows up as a
 *                   doubled row count.
 *
 * Determinism has one specific consequence worth stating: card positions are
 * generated with `keysBetween`, which is jittered, so the *keys* differ between
 * runs by design. The *order* does not. `seed-check.sh` digests the rank inside
 * each list rather than the raw key for exactly this reason; its header explains
 * the trade.
 *
 * The five DEMO_* constants below are read by shell scripts with a single `sed`
 * each (`scripts/dev-smoke.sh`, `scripts/seed-check.sh`). Keep them as top-level
 * `const NAME = '...';` declarations on one line -- a template literal or a
 * multi-line object would break those greps, and the failure would be a check
 * that silently asserts nothing.
 */
import { keysBetween } from '@kan/ordering';
import { initialsOf } from '@kan/shared';
import { hashPassword } from '@kan/shared/server';

import { PrismaClient, type BoardRole } from '../src';

const prisma = new PrismaClient();

// --- Read by scripts/dev-smoke.sh and scripts/seed-check.sh -----------------
const DEMO_EMAIL = 'ana@kanban.local';
const DEMO_PASSWORD = 'kanban-demo-2026';
const DEMO_BOARD_NAME = 'Product launch';
const DEMO_LIST_NAME = 'In progress';
const DEMO_CARD_TITLE = 'Wire the presence bar';
// ---------------------------------------------------------------------------

/**
 * Four people with four different roles, because the permission matrix is a
 * feature and a seed with one user cannot demonstrate it.
 *
 * Ana owns both boards. Bruno edits. Carla views -- she is the account the E2E
 * suite signs in as to prove a viewer cannot drag. Dan is a member of the second
 * board only, which is what makes "boards you can see" a real query rather than
 * "every board".
 */
const PEOPLE = [
  { email: DEMO_EMAIL, name: 'Ana Ruiz', timeZone: 'Europe/Madrid' },
  { email: 'bruno@kanban.local', name: 'Bruno Salas', timeZone: 'America/Santiago' },
  { email: 'carla@kanban.local', name: 'Carla Ortiz', timeZone: 'Europe/Madrid' },
  { email: 'dan@kanban.local', name: 'Dan Weber', timeZone: 'UTC' },
] as const;

/** One password for every demo account. It is in the README; it is not a secret. */
const PASSWORD = DEMO_PASSWORD;

interface SeedCard {
  readonly title: string;
  readonly description?: string;
  readonly labels?: readonly string[];
  /** Days from the reference day. Negative is overdue, which the board must show. */
  readonly dueInDays?: number;
  readonly assignee?: string;
}

interface SeedList {
  readonly name: string;
  readonly wipLimit?: number;
  readonly cards: readonly SeedCard[];
}

interface SeedBoard {
  readonly name: string;
  readonly members: readonly { readonly email: string; readonly role: BoardRole }[];
  readonly labels: readonly { readonly name: string; readonly colorSlot: number }[];
  readonly lists: readonly SeedList[];
}

/**
 * A fixed reference day, not `new Date()`.
 *
 * Due dates are stored relative to this so the board always contains one overdue
 * card, one due today and several upcoming -- the three states the card badge has
 * to render. Reading the real clock would make "overdue" drift into "upcoming"
 * overnight and take the E2E assertion with it.
 */
const REFERENCE_DAY = new Date(Date.UTC(2026, 2, 9)); // 2026-03-09

function dueDate(days: number): Date {
  return new Date(REFERENCE_DAY.getTime() + days * 86_400_000);
}

const BOARDS: readonly SeedBoard[] = [
  {
    name: DEMO_BOARD_NAME,
    members: [
      { email: DEMO_EMAIL, role: 'OWNER' },
      { email: 'bruno@kanban.local', role: 'EDITOR' },
      { email: 'carla@kanban.local', role: 'VIEWER' },
    ],
    labels: [
      { name: 'Bug', colorSlot: 0 },
      { name: 'Design', colorSlot: 1 },
      { name: 'Backend', colorSlot: 2 },
      { name: 'Docs', colorSlot: 3 },
    ],
    lists: [
      {
        // No WIP limit. The board has to render all four states on load, and
        // "no limit" is one of them: `wipStateFor` returns `none` here and the
        // column shows a plain count rather than a ratio.
        name: 'Backlog',
        cards: [
          { title: 'Draft the launch email', labels: ['Docs'], dueInDays: 12 },
          { title: 'Pick the pricing tiers', dueInDays: 9 },
          { title: 'Audit the onboarding copy', labels: ['Docs'] },
          { title: 'Decide on a changelog format' },
          { title: 'Collect beta feedback', assignee: 'carla@kanban.local' },
          { title: 'Sketch the empty states', labels: ['Design'] },
          { title: 'Plan the migration rehearsal', labels: ['Backend'], dueInDays: 15 },
          { title: 'Shortlist the launch reviewers', assignee: 'bruno@kanban.local' },
        ],
      },
      {
        // Four against six: the `under` state, a ratio with room left in it.
        name: 'Ready',
        wipLimit: 6,
        cards: [
          {
            title: 'Rate-limit the socket handshake',
            description: 'One connection per second per address, burst of five.',
            labels: ['Backend'],
            dueInDays: 4,
            assignee: 'bruno@kanban.local',
          },
          { title: 'Add the keyboard drag announcement', labels: ['Design'], dueInDays: 2 },
          { title: 'Write the architecture diagram', labels: ['Docs'] },
          { title: 'Cache the board read for reconnects', labels: ['Backend'], dueInDays: 6 },
        ],
      },
      {
        // The WIP limit is on this list on purpose: it holds three cards against a
        // limit of three, so the board renders the "at limit" state on load. A
        // limit nothing reaches is a feature nobody can see in a screenshot.
        name: DEMO_LIST_NAME,
        wipLimit: 3,
        cards: [
          {
            title: DEMO_CARD_TITLE,
            description: 'Swatch, initials and a word. Never colour alone.',
            labels: ['Design', 'Backend'],
            dueInDays: 0,
            assignee: DEMO_EMAIL,
          },
          {
            title: 'Fix the stale-move rollback',
            description: 'A rejected move must put the card back where it was.',
            labels: ['Bug'],
            dueInDays: -2,
            assignee: 'bruno@kanban.local',
          },
          { title: 'Reconnect without losing presence', labels: ['Backend'], dueInDays: 1 },
        ],
      },
      {
        name: 'Done',
        cards: [
          { title: 'Choose the ordering scheme', labels: ['Backend'] },
          { title: 'Set up the Postgres invariants', labels: ['Backend'] },
          { title: 'Name the colour palette', labels: ['Design'] },
          { title: 'Agree the socket event names', labels: ['Backend', 'Docs'] },
          { title: 'Measure the concurrent-drag proof', labels: ['Backend'] },
        ],
      },
    ],
  },
  {
    name: 'Support rota',
    members: [
      { email: DEMO_EMAIL, role: 'OWNER' },
      { email: 'dan@kanban.local', role: 'EDITOR' },
    ],
    labels: [
      { name: 'Urgent', colorSlot: 0 },
      { name: 'Waiting', colorSlot: 4 },
    ],
    lists: [
      {
        name: 'Reported',
        cards: [
          { title: 'Board loads blank on Safari 16', labels: ['Urgent'], dueInDays: -1 },
          { title: 'Export button does nothing', labels: ['Waiting'] },
          { title: 'Timezone off by one on due dates', dueInDays: 3 },
          { title: 'Drag ghost sticks after a failed drop', labels: ['Urgent'], dueInDays: -3 },
          { title: 'Presence chip keeps a stale name', labels: ['Waiting'] },
          { title: 'Activity feed stops at page two' },
          { title: 'WIP counter lags one card behind', labels: ['Urgent'] },
          { title: 'Invite email lands in spam', labels: ['Waiting'], dueInDays: 5 },
          { title: 'Board list order flickers on load' },
        ],
      },
      {
        // Three against two: the `over` state. Deliberate, and the reason this
        // list exists in the seed at all. "Over limit" is the one WIP state a
        // board cannot reach by accident on first load, so without a column that
        // is already over, the red-and-a-word treatment ships untested and
        // unscreenshotted. A support queue that has overrun its limit is also the
        // most honest example of the state.
        name: 'Investigating',
        wipLimit: 2,
        cards: [
          {
            title: 'Duplicate cards after a reconnect',
            description: 'Suspect a missed board.state on resubscribe.',
            labels: ['Urgent'],
            assignee: 'dan@kanban.local',
            dueInDays: 0,
          },
          {
            title: 'Redis adapter drops a broadcast under load',
            description: 'Only reproduces with two gateway replicas.',
            labels: ['Urgent'],
            assignee: 'dan@kanban.local',
            dueInDays: -1,
          },
          { title: 'Socket reconnect loops on a 401', labels: ['Waiting'], dueInDays: 2 },
        ],
      },
      {
        name: 'Resolved',
        cards: [
          { title: 'Slow board with 400 cards' },
          { title: 'Card title truncated at 40 characters', labels: ['Waiting'] },
          { title: 'Due badge wrong for the last day of a month' },
          { title: 'Archived cards counted in the board summary', labels: ['Urgent'] },
          { title: 'Keyboard drag skipped the last position', labels: ['Waiting'] },
          { title: 'Label chip unreadable in dark mode' },
          { title: 'Member list showed a removed person', labels: ['Urgent'] },
          { title: 'Health check green with a dead Redis' },
        ],
      },
    ],
  },
];

async function main(): Promise<void> {
  const emails = PEOPLE.map((person) => person.email);

  /**
   * Teardown, in the one order that works. Three steps, and the order is the
   * whole point.
   *
   * The obvious version -- `user.deleteMany` and let the cascades run -- is what
   * this had first, and `scripts/seed-check.sh` caught it on the second run:
   *
   *   Foreign key constraint violated: activities_actor_id_fkey
   *
   * `Activity.actor` is `onDelete: Restrict` on purpose (see schema.prisma):
   * deleting a person must not silently rewrite the history of what they did. The
   * first seed run has no activity rows yet, so it passes; the second one has the
   * BOARD_CREATED rows the first one wrote, and refuses. A seed that only ever
   * ran on an empty database would have shipped this.
   *
   * So the activity has to go before its actor, and it goes by way of the board,
   * which owns it with a real cascade.
   */

  // 1. Boards, found through their memberships rather than by name. A board the
  //    E2E suite renamed is still this seed's to clean up, and its cascade takes
  //    the lists, cards, labels, memberships and activity rows with it.
  await prisma.board.deleteMany({
    where: {
      OR: [
        { members: { some: { user: { email: { in: [...emails] } } } } },
        { name: { in: BOARDS.map((board) => board.name) } },
      ],
    },
  });

  // 2. Any activity these people authored on a board that is not theirs. Nothing
  //    in this seed creates one, but the E2E suite adds a member to a board and
  //    then acts as them, and one leftover row here would block step 3 with the
  //    same foreign key error, on a run nobody would connect to the test that
  //    caused it.
  await prisma.activity.deleteMany({ where: { actor: { email: { in: [...emails] } } } });

  // 3. The people. Their memberships and card assignments cascade or null out;
  //    if any of those relations is missing its `onDelete`, this leaves orphans
  //    and seed-check.sh reports a doubled row count on the second run -- which is
  //    the only place a missing cascade is visible at all.
  await prisma.user.deleteMany({ where: { email: { in: [...emails] } } });

  const passwordHash = hashPassword(PASSWORD);
  const users = new Map<string, string>();
  for (const person of PEOPLE) {
    const user = await prisma.user.create({
      data: {
        email: person.email,
        name: person.name,
        // Hashed once and reused. `hashPassword` salts randomly, so calling it per
        // user would be four scrypt derivations for one password and would make
        // the stored hashes differ between runs -- harmless, but it is one more
        // thing that is not identical between two seeds.
        passwordHash,
        timeZone: person.timeZone,
      },
    });
    users.set(person.email, user.id);
  }

  const userId = (email: string): string => {
    const id = users.get(email);
    if (!id) throw new Error(`Seed refers to a person it never created: ${email}`);
    return id;
  };

  for (const board of BOARDS) {
    const created = await prisma.board.create({
      data: {
        name: board.name,
        members: {
          create: board.members.map((member) => ({
            userId: userId(member.email),
            role: member.role,
          })),
        },
        labels: {
          create: board.labels.map((label) => ({ name: label.name, colorSlot: label.colorSlot })),
        },
      },
      include: { labels: true },
    });

    const labelIds = new Map(created.labels.map((label) => [label.name, label.id]));

    // One call per column rather than one per card. `keysBetween` returns keys
    // that are already strictly ascending, which is what makes the seeded order
    // the rendered order; generating them one at a time against a growing list
    // would work too and would be N round trips of arithmetic for no gain.
    const listPositions = keysBetween(null, null, board.lists.length);

    for (const [listIndex, list] of board.lists.entries()) {
      const cardPositions = keysBetween(null, null, list.cards.length);

      await prisma.list.create({
        data: {
          boardId: created.id,
          name: list.name,
          position: listPositions[listIndex]!,
          wipLimit: list.wipLimit ?? null,
          cards: {
            create: list.cards.map((card, cardIndex) => ({
              title: card.title,
              description: card.description ?? null,
              position: cardPositions[cardIndex]!,
              dueOn: card.dueInDays === undefined ? null : dueDate(card.dueInDays),
              assigneeId: card.assignee ? userId(card.assignee) : null,
              labels: card.labels
                ? {
                    create: card.labels.map((name) => {
                      const labelId = labelIds.get(name);
                      if (!labelId) {
                        throw new Error(
                          `Card "${card.title}" wants a label the board lacks: ${name}`,
                        );
                      }
                      return { labelId };
                    }),
                  }
                : undefined,
            })),
          },
        },
      });
    }

    // One activity row per board, so the feed is not empty on first load. The
    // actor is the owner, and `createdAt` is left to the database: the feed is
    // ordered by it, and a seeded timestamp in the past would be indistinguishable
    // from a real one while never matching what the E2E suite just did.
    await prisma.activity.create({
      data: {
        boardId: created.id,
        actorId: userId(board.members[0]!.email),
        type: 'BOARD_CREATED',
        subject: board.name,
        detail: null,
      },
    });
  }

  const cardCount = BOARDS.reduce(
    (total, board) => total + board.lists.reduce((sum, list) => sum + list.cards.length, 0),
    0,
  );

  console.log(
    `Seeded ${BOARDS.length} boards, ${PEOPLE.length} people (${PEOPLE.map((p) => initialsOf(p.name)).join(', ')}), ` +
      `${cardCount} cards.\n` +
      `Sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
