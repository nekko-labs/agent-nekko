import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { composite, contrastRatio, parseColor } from './contrast.js';

/**
 * The merged-PR banner put fixed light-violet text on a gradient that is
 * transparent on its left, so in light mode the repository label sat on
 * near-white paper at 1.15:1. These checks read the shipped theme tokens out
 * of styles.css and hold every piece of merged text to WCAG AA (4.5:1) on the
 * darkest and lightest parts of what it sits on, in every theme and preset.
 */

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

/** The custom properties declared directly in the first block for `selector`. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No ${selector} block in styles.css`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n  }', start));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

const light = block(':root');
const dark = { ...light, ...block("[data-theme='dark']") };
const THEMES: Record<string, Record<string, string>> = {
  light,
  'light/solar': { ...light, ...block("[data-theme='light'][data-preset='solar']") },
  dark,
  'dark/nebula': { ...dark, ...block("[data-theme='dark'][data-preset='nebula']") },
  'dark/terminal': { ...dark, ...block("[data-theme='dark'][data-preset='terminal']") },
  'dark/nord': { ...dark, ...block("[data-theme='dark'][data-preset='nord']") },
};

const AA = 4.5;

describe('contrast helper', () => {
  it('matches the WCAG reference points', () => {
    expect(contrastRatio(parseColor('#000'), parseColor('#fff'))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor('#fff'), parseColor('#fff'))).toBeCloseTo(1, 5);
    // The reported bug: violet-100 on light paper.
    expect(contrastRatio(parseColor('#ede9fe'), parseColor('#fbfbfd'))).toBeLessThan(1.2);
  });
  it('composites translucent colours over paper', () => {
    const half = composite(parseColor('rgba(0, 0, 0, 0.5)'), parseColor('#ffffff'));
    expect(Math.round(half.r)).toBe(128);
  });
});

describe.each(Object.entries(THEMES))('merged PR colours in %s', (_name, vars) => {
  const get = (name: string) => {
    const value = vars[name];
    if (!value) throw new Error(`${name} is not defined`);
    return parseColor(value);
  };
  const paper = get('--paper');
  const surface = get('--surface');
  // The banner gradient runs from transparent (bare paper) to the full wash.
  const bannerStops = { 'bare paper': paper, 'soft wash': composite(get('--merged-wash-soft'), paper), 'full wash': composite(get('--merged-wash'), paper) };

  it.each(['--ink', '--ink-soft', '--merged-ink'])('%s is readable across the whole banner', (token) => {
    for (const [stop, background] of Object.entries(bannerStops)) {
      const ratio = contrastRatio(get(token), background);
      expect(ratio, `${token} on ${stop} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
    }
  });

  it('the merged chip and link are readable', () => {
    for (const base of [paper, surface]) {
      expect(contrastRatio(get('--merged-ink'), composite(get('--merged-chip'), base))).toBeGreaterThanOrEqual(AA);
      expect(contrastRatio(get('--merged-ink'), base)).toBeGreaterThanOrEqual(AA);
    }
  });
});
