/**
 * WCAG 2.x contrast for theme colours. Pure, so tests can hold text that sits
 * on a tinted surface (the merged-PR banner, status chips) to a minimum ratio
 * in every theme rather than trusting that a colour picked on dark paper also
 * reads on light paper.
 */

export type Rgba = { r: number; g: number; b: number; a: number };

/** Parse `#rgb`, `#rrggbb` or `rgb()/rgba()` with comma or space syntax. */
export function parseColor(input: string): Rgba {
  const s = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(s);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return { r: parts[0], g: parts[1], b: parts[2], a: Number.isFinite(parts[3]) ? parts[3] : 1 };
    }
  }
  throw new Error(`Unsupported colour: ${input}`);
}

/** Paint `top` (possibly translucent) over an opaque `bottom`. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const mix = (t: number, b: number) => t * top.a + b * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function luminance({ r, g, b }: Rgba): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio of opaque text over an opaque background, 1 to 21. */
export function contrastRatio(text: Rgba, background: Rgba): number {
  const [hi, lo] = [luminance(text), luminance(background)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
