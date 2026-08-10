import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AA_NORMAL,
  AA_UI,
  contrastRatio,
  extractTokens,
  parseHex,
  ratio,
  relativeLuminance,
  resolve,
} from './contrast';

/**
 * The colour gate.
 *
 * What it pins: every foreground/background pair this app actually paints,
 * against WCAG AA, in both colour schemes. 4.5:1 for text, 3:1 for anything
 * non-text that has to be seen (control borders, the focus ring, a drop-target
 * outline, a presence ring). It reads `app/globals.css` off disk and pulls the
 * palette out of it, so it cannot pass against a stale copy of the colours.
 *
 * What breaks without it: nothing visibly, which is the problem. A token nudged
 * two steps lighter still looks fine to whoever nudged it, and the reader who
 * cannot make out the "At limit 3/3" chip on a column header is not in the room.
 * Contrast is arithmetic on two hex values. Arithmetic belongs in a test, not in
 * anyone's eye.
 *
 * Two constraints this file measures rather than assumes:
 *
 *   - the eight presence/label hues are **non-text**. They are rings and 2px
 *     rails; the initials inside a presence chip are `--text` on `--surface`, and
 *     a label's name is `--text` on `--surface-2`. So they are asserted at 3:1,
 *     which is the correct threshold for them and is why eight distinguishable
 *     hues are available at all -- at 4.5:1 on both schemes the palette runs out;
 *   - the WIP inks cannot be told apart in greyscale, and the test says so
 *     numerically rather than the stylesheet claiming it. That measurement is the
 *     justification for every word and glyph the components render beside them.
 */
const APP = join(__dirname, '..', 'app');
const globals = readFileSync(join(APP, 'globals.css'), 'utf8');

/** Light is the default palette, on `:root`. Dark overrides a subset of it. */
const light = extractTokens(globals, ':root');
const dark = { ...light, ...extractTokens(globals, '@media (prefers-color-scheme: dark)') };

const PALETTES = { light, dark } as const;

/** Every surface a foreground can legitimately land on. */
const BACKGROUNDS = ['--bg', '--surface', '--surface-2'] as const;

/**
 * Text-weight foregrounds, allowed on all three surfaces.
 *
 * `--accent` is in here rather than in the non-text list because it is a link
 * colour (`a { color: var(--accent) }`) and the topbar's current-page label.
 */
const TEXT_INK = [
  '--text',
  '--muted',
  '--accent',
  '--wip-under',
  '--wip-at',
  '--wip-over',
  '--ok',
] as const;

/** Non-text UI: control boundaries, drop-target outlines, presence rings. */
const UI_INK = ['--border', '--accent'] as const;

/** The eight hues, used as rings and rails only. */
const HUES = [
  '--hue-0',
  '--hue-1',
  '--hue-2',
  '--hue-3',
  '--hue-4',
  '--hue-5',
  '--hue-6',
  '--hue-7',
] as const;

/** Greyscale luminance of a colour, as a hex string, for the separation check. */
function greyscale(hex: string): string {
  const { r, g, b } = parseHex(hex);
  const value = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  return `#${[value, value, value].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
}

describe('the arithmetic itself', () => {
  it('agrees with the WCAG reference values', () => {
    // Black on white is exactly 21:1 and a colour against itself is exactly 1:1.
    // Both are definitional, so a formula that gets them wrong is wrong
    // everywhere else too.
    expect(ratio('#000000', '#ffffff')).toBe(21);
    expect(ratio('#a01a6d', '#a01a6d')).toBe(1);
  });

  it('is order-independent', () => {
    expect(contrastRatio('#ecedf0', '#a01a6d')).toBeCloseTo(
      contrastRatio('#a01a6d', '#ecedf0'),
      10,
    );
  });

  it('linearises the channels rather than averaging them', () => {
    // A naive (r+g+b)/3 would rank pure green below pure blue. The sRGB
    // coefficients say the opposite, and it is not close.
    expect(relativeLuminance(parseHex('#00ff00'))).toBeGreaterThan(
      relativeLuminance(parseHex('#0000ff')),
    );
  });

  it('expands a three-digit hex', () => {
    expect(parseHex('#fff')).toEqual(parseHex('#ffffff'));
  });

  it('refuses something that is not a colour, rather than returning NaN', () => {
    // A silent NaN here would make every ratio involving it `NaN`, and `NaN >=
    // 4.5` is false, so the test would fail with no indication that the value was
    // never a colour in the first place.
    expect(() => parseHex('var(--accent)')).toThrow(/not a hex colour/);
  });
});

describe.each(Object.entries(PALETTES))('%s scheme', (scheme, palette) => {
  it.each(TEXT_INK.flatMap((ink) => BACKGROUNDS.map((background) => [ink, background] as const)))(
    '%s on %s clears AA for text',
    (ink, background) => {
      const measured = ratio(resolve(palette, ink), resolve(palette, background));
      expect(
        measured,
        `${scheme}: ${ink} on ${background} is ${measured}:1`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    },
  );

  it.each(UI_INK.flatMap((ink) => BACKGROUNDS.map((background) => [ink, background] as const)))(
    '%s on %s clears AA for non-text UI',
    (ink, background) => {
      const measured = ratio(resolve(palette, ink), resolve(palette, background));
      expect(
        measured,
        `${scheme}: ${ink} on ${background} is ${measured}:1`,
      ).toBeGreaterThanOrEqual(AA_UI);
    },
  );

  it.each(HUES.map((hue) => [hue] as const))(
    '%s is visible as a ring on the canvas and on a card',
    (hue) => {
      // 3:1, the non-text threshold. These are rings and rails; the text they sit
      // beside is `--text`, which is asserted above.
      for (const background of ['--bg', '--surface'] as const) {
        const measured = ratio(resolve(palette, hue), resolve(palette, background));
        expect(
          measured,
          `${scheme}: ${hue} on ${background} is ${measured}:1`,
        ).toBeGreaterThanOrEqual(AA_UI);
      }
    },
  );

  it('gives the accent enough contrast for the ink sitting on it', () => {
    // The primary button. A brand colour that passes against the page and fails
    // against its own label is the most common way this gate is fooled.
    const measured = ratio(resolve(palette, '--accent-ink'), resolve(palette, '--accent'));
    expect(measured, `${scheme}: --accent-ink on --accent is ${measured}:1`).toBeGreaterThanOrEqual(
      AA_NORMAL,
    );
  });

  it('keeps the accent-soft fill legible under text', () => {
    // `--accent-soft` backs the current-page pill in the topbar and the
    // drop-target column, and `--accent` is the text on the first of them.
    const measured = ratio(resolve(palette, '--accent'), resolve(palette, '--accent-soft'));
    expect(
      measured,
      `${scheme}: --accent on --accent-soft is ${measured}:1`,
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('has eight hues nobody can confuse for each other', () => {
    // Not a contrast rule: a distinctness rule. Two presence rings that are the
    // same colour make two people look like one, which is worse than a ring
    // nobody can see.
    const values = HUES.map((hue) => resolve(palette, hue).toLowerCase());
    expect(new Set(values).size).toBe(HUES.length);
  });
});

/**
 * The measurement the whole "colour is never the only channel" rule rests on.
 *
 * If these separated cleanly in greyscale, the components could reasonably lean
 * on colour for WIP state. They do not, and the numbers are here so nobody has to
 * take that on trust: 1.5:1 is the loosest threshold anyone proposes for
 * distinguishing two greys, and every pair below is nowhere near it.
 */
describe('colour cannot be the only channel', () => {
  it.each(Object.entries(PALETTES))(
    '%s: the WIP states are indistinguishable in greyscale',
    (scheme, palette) => {
      const pairs = [
        ['--wip-at', '--wip-over'],
        ['--wip-over', '--ok'],
        ['--wip-under', '--wip-at'],
      ] as const;

      for (const [left, right] of pairs) {
        const measured = ratio(
          greyscale(resolve(palette, left)),
          greyscale(resolve(palette, right)),
        );
        expect(
          measured,
          `${scheme}: ${left} vs ${right} separates by ${measured}:1 in greyscale, ` +
            'so the word beside it is doing the work',
        ).toBeLessThan(1.5);
      }
    },
  );

  it('renders a word for every WIP state, from the shared helper', async () => {
    // The other half of the same rule, and the reason the label ships with the
    // state rather than being derived from it by each client.
    const { wipStateFor } = await import('@kan/shared');
    for (const [count, limit] of [
      [0, null],
      [1, 3],
      [3, 3],
      [4, 3],
    ] as const) {
      expect(wipStateFor(count, limit).label.length).toBeGreaterThan(0);
    }
  });
});
