import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every class a component asks for exists in the stylesheet.
 *
 * This gate is here because of a bug the whole test suite walked past.
 * `CategoryBarChart` wrapped its Recharts container in `<div className="chart-bars">`
 * and `.chart-bars` was never written. Recharts' `ResponsiveContainer` measures
 * its parent, `height="100%"` inside a box with no height resolves to zero, and
 * the by-category chart rendered *nothing* on the dashboard and the report: no
 * error, no empty state, a blank strip above the `<details>` table. Typecheck
 * passed, the contrast gate passed, `tokens.test.ts` passed, axe passed (there
 * was nothing to fail on), and every e2e assertion about that section passed
 * because they all target the table alternative. A screenshot is what found it.
 *
 * The reverse direction is deliberately **not** checked. An unused rule in a
 * stylesheet is dead weight; a missing rule is a feature that silently does not
 * exist, and only one of those is worth failing a commit over.
 *
 * Class names are collected from static `className` literals only. A template
 * with an interpolation in it (`` `state ${label.className}` ``) contributes its
 * literal parts and nothing else, because the interpolated half comes from
 * `lib/format.ts`, whose own tests pin the values it can produce.
 */

const WEB = join(__dirname, '..');
const STYLESHEET = join(WEB, 'app', 'globals.css');

const SOURCE_DIRS = ['app', 'components'];
const SOURCE_EXTENSIONS = new Set(['.tsx', '.ts']);
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist']);

/**
 * Classes that exist for JavaScript or for the E2E suite rather than for CSS.
 *
 * Empty on purpose, and it should stay that way: a class with no rule is either
 * a bug or a selector that belongs in a `data-` attribute. It exists so that
 * adding one is a deliberate line in a diff and not a silent exception.
 */
const WITHOUT_STYLES = new Set<string>([]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (SOURCE_EXTENSIONS.has(extname(entry.name)) && !entry.name.endsWith('.test.ts')) {
      yield full;
    }
  }
}

/** Every `className` value in a file, as (class name, where) pairs. */
function classNamesIn(source: string, where: string): { name: string; where: string }[] {
  const found: { name: string; where: string }[] = [];

  // Three spellings React accepts: className="a b", className={'a b'} and
  // className={`a ${x} b`}. The template case keeps its literal segments and
  // drops the interpolations, which is why the pattern splits on `${...}`.
  const patterns = [
    /className\s*=\s*"([^"]*)"/g,
    /className\s*=\s*\{\s*'([^']*)'\s*\}/g,
    /className\s*=\s*\{\s*`([^`]*)`/g,
    /className:\s*'([^']*)'/g,
    /className:\s*`([^`]*)`/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = match[1] ?? '';
      for (const segment of value.split(/\$\{[^}]*\}/)) {
        for (const name of segment.split(/\s+/)) {
          // A trailing hyphen means the token was the *prefix* of an
          // interpolated name -- `meter-${status.state}` leaves `meter-` behind
          // -- and the whole name is decided at runtime. The values it can take
          // are pinned by `format.ts`'s own tests, so reporting the stub here
          // would be an unfixable failure.
          if (/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name)) found.push({ name, where });
        }
      }
    }
  }
  return found;
}

/** Every class selector the stylesheet declares a rule for. */
function declaredClasses(css: string): Set<string> {
  const declared = new Set<string>();
  // Every prelude: the text between a brace boundary and the `{` that opens a
  // block. That is a selector list for an ordinary rule and an at-rule prelude
  // for `@media`, and only the first kind carries `.class` tokens -- which is
  // what makes nesting work without a parser. Splitting on `}` alone would miss
  // every rule inside a media query, because the media block's own `{` comes
  // first and swallows the rest of the chunk.
  for (const match of css.matchAll(/([^{}]*)\{/g)) {
    const prelude = match[1] ?? '';
    for (const cls of prelude.matchAll(/\.([a-z][a-z0-9-]*)/g)) {
      if (cls[1] !== undefined) declared.add(cls[1]);
    }
  }
  return declared;
}

describe('every class a component uses has a rule', () => {
  const css = readFileSync(STYLESHEET, 'utf8');
  const declared = declaredClasses(css);

  const used: { name: string; where: string }[] = [];
  for (const dir of SOURCE_DIRS) {
    for (const file of walk(join(WEB, dir))) {
      used.push(...classNamesIn(readFileSync(file, 'utf8'), relative(WEB, file)));
    }
  }

  it('found classes to check, so a broken scan cannot pass silently', () => {
    expect(used.length).toBeGreaterThan(50);
    expect(declared.size).toBeGreaterThan(30);
  });

  it('declares the classes this test was written for', () => {
    // The regression this gate exists for, in this project's terms. A sibling
    // repo used `.chart-bars` in a component and never wrote the rule; Recharts
    // measured a zero-height parent and drew nothing, silently. The equivalents
    // here are the drag affordances: a `.column-over` or `.card-placeholder` that
    // matches no rule means the drop target has no visible state at all, and a
    // drag with no visible target is the one interaction this product is for.
    for (const name of ['column-over', 'card-placeholder', 'card-dragging', 'presence-dragging']) {
      expect(declared.has(name), `.${name} must have a rule`).toBe(true);
    }
  });

  it('has a rule for every class used in a component', () => {
    const missing = used
      .filter((entry) => !declared.has(entry.name) && !WITHOUT_STYLES.has(entry.name))
      .map((entry) => `${entry.name} (${entry.where})`);

    expect([...new Set(missing)].sort()).toEqual([]);
  });
});

describe('the scanners themselves', () => {
  it('reads a plain string className', () => {
    expect(classNamesIn('<div className="card card-head">', 'x').map((e) => e.name)).toEqual([
      'card',
      'card-head',
    ]);
  });

  it('keeps the literal half of a template and drops the interpolation', () => {
    const found = classNamesIn('<span className={`state ${label.className}`}>', 'x');
    expect(found.map((e) => e.name)).toEqual(['state']);
  });

  it('ignores a conditional expression it cannot resolve', () => {
    // `className={skip ? 'import-row-skipped' : undefined}` is not one of the
    // spellings scanned, and that is the honest answer: guessing at a ternary is
    // how a scanner starts reporting classes nobody wrote.
    expect(classNamesIn("className={skip ? 'a' : undefined}", 'x').map((e) => e.name)).toEqual([]);
  });

  it('reads a selector list, not a declaration value', () => {
    const declared = declaredClasses('.a, .b > .c { color: var(--x); background: url(.d); }');
    expect([...declared].sort()).toEqual(['a', 'b', 'c']);
  });

  it('reads a class used inside a media query', () => {
    const declared = declaredClasses('@media (min-width: 40em) { .wide { display: flex; } }');
    expect(declared.has('wide')).toBe(true);
  });
});
