/**
 * The Agent Nekko mark, as vector art: the orbit (a comet of light running a tilted
 * ring, violet into cyan, over deep space) plus the installer banners that reuse
 * it. Pure string-building with no renderer behind it, so anything that needs
 * the mark -- the desktop icon pipeline, the marketing site's favicon -- draws
 * from this one source instead of keeping its own copy of the shape.
 */

/* ── the mark ─────────────────────────────────────────────────────────────── */

const VIEWBOX = 512; // centre of the 512 viewBox
const INK = '#f2f1e9';
const RIM = '#a7c8ac';
/** What the trail fades into: roughly the sky behind its tail. */
const TILE = '#101714';
const MARK_SCALE = 20; // degrees; enough to read as depth, not as a flat ring
/** Where the body sits on the orbit, in ellipse parameter degrees. */
const GINGER = '#f0a35e';
/** How far back the trail reaches from the head. */
const HEAD_PATH = 'M 5.5 10 C 5.8 6.1 7.1 3.4 7.4 2.2 Q 7.7 0.7 8.9 1.7 L 12.9 5.1 L 17.1 1.7 Q 18.3 0.7 18.6 2.2 C 18.9 3.4 20.2 6.1 20.5 10 L 20.5 17.4 C 20.5 21.2 17.2 23.2 13 23.2 C 8.8 23.2 5.5 21.2 5.5 17.4 Z';

/** Point at parameter `t` (degrees) on the tilted orbit. */
const INNER_EARS = 'M 7.9 6 L 8 3.1 L 10.5 5.2 M 15.5 5.2 L 18 3.1 L 18.1 6';

/** Blend two #rrggbb colours. */
const GLASSES = 'M 8.3 12.4 L 12.1 12.7 L 11.7 15 Q 9.9 15.6 8.7 14.5 Z M 14 12.7 L 17.8 12.4 L 17.4 14.5 Q 16.2 15.6 14.4 15 Z';

/**
 * The comet's trail, as one tapered ribbon: sample the orbit, offset each sample
 * along its normal by a half-width that grows toward the head, and close the two
 * sides into a single filled path.
 *
 * Drawing it as a run of stroked segments instead (the obvious approach) beads
 * visibly, because every semi-transparent round cap double-composites over its
 * neighbour. One path with one gradient has no seams to show.
 */
function headSvg(size) {
  // Edge points of the ribbon at each sample, plus the colour that band should
  // end up. The fade has to follow arc length, not a straight gradient axis: the
  // trail wraps 300 degrees, so its tail ends up spatially next to its head and
  // any linear gradient collapses to a sliver of violet.
  const outlineWidth = size < 32 ? 2 : 1.7;
  // Tangent by finite difference, so the normal follows the tilted ellipse.
  const glassesWidth = size < 32 ? 1.05 : 0.9;
  // Width flares late, so the tail stays a thin filament for most of its run.
  const earpieceWidth = size < 32 ? 1.35 : 1.2;
  // Opaque fill, faded by mixing toward the sky rather than by alpha: two
  // adjacent translucent bands would double-composite into a visible seam.
  const parts = [
    `<path d="${HEAD_PATH}" fill="${TILE}" stroke="${INK}" stroke-width="${outlineWidth}" stroke-linejoin="round"/>`,
    `<path data-part="inner-ears" d="${INNER_EARS}" stroke="${GINGER}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
  ];
  // Each band spans two samples, so it overlaps its neighbour and no
  // antialiased hairline can show through between them. Painted tail first, so
  // the brighter band always lands on top of the dimmer one it overlaps.
  parts.push(`<g data-mascot-accessory="sunglasses" fill="${INK}" stroke="${INK}" stroke-width="${glassesWidth}" stroke-linejoin="round" stroke-linecap="round">
      <path d="${GLASSES}"/>
      <path d="M 12 13.2 Q 13 12.6 14.1 13.2 M 8.3 12.6 L 7 12 M 17.8 12.6 L 19.1 12" fill="none"/>
    </g>`);
  // A round cap where the ribbon meets the body.
  parts.push(
    `<path data-mascot-accessory="earpiece" d="M 20.5 12.9 Q 22.6 12.9 22.6 14.5 Q 22.6 16.1 20.5 16.1" fill="${TILE}" stroke="${INK}" stroke-width="${earpieceWidth}" stroke-linecap="round"/>`,
    `<path data-part="mouth" d="M 11.8 17.3 q 1.2 1.1 2.4 0" stroke="${INK}" stroke-width="1" stroke-linecap="round" fill="none"/>`,
  );
  return parts.join('\n    ');
}

/**
 * The Agent Nekko mark: an orbit. A comet of light running a tilted ring, violet
 * into cyan (the brand gradient), over deep space. Abstract on purpose: one
 * sweeping arc plus one bright body reads at 16px, where the mascot cannot.
 *
 * Everything is expressed in a 512 viewBox and scaled by the renderer, so the
 * only size-dependent decisions are how much detail survives.
 */
function iconSvg(size, px = size) {
  // Small icons need a heavier stroke and a bigger head, or they read as a smudge.
  const rimWidth = size >= 48 ? 6 : 10;
  const corner = 114; // 22.3% of 512, the platform squircle radius

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}">
  <defs>
    <clipPath id="squircle">
      <rect x="0" y="0" width="512" height="512" rx="${corner}" ry="${corner}"/>
    </clipPath>
  </defs>

  <g clip-path="url(#squircle)">
    <rect width="512" height="512" fill="${TILE}"/>

    <!-- No closed ring behind the trail: at icon scale a second stroke reads as
         a competing shape. The arc sweeps nearly a full lap, which is enough to
         say "orbit" on its own. -->
    <g data-part="mini-nekko" transform="scale(${MARK_SCALE})" fill="none">
    ${headSvg(size)}
    </g>

    <!-- The body: a hot white core inside a cyan bloom. -->
  </g>

  <!-- Rim light. A dark tile on a dark taskbar loses its own edge; a hairline of
       the accent gives it back without lightening the art. -->
  <rect x="3" y="3" width="506" height="506" rx="${corner - 3}" ry="${corner - 3}"
        fill="none" stroke="${RIM}" stroke-opacity="0.72" stroke-width="${rimWidth}"/>
</svg>`;
}

/* ── the NSIS installer art ───────────────────────────────────────────────── */

/**
 * The Windows installer's header strip and sidebar panel. Same deep space, same
 * mark, and the product's actual name: these two were still shipping the
 * pre-rebrand "Open Paw" wordmark and the orange cat.
 *
 * `bare` drops the squircle and the background so the mark can sit on the
 * panel's own space instead of on a rounded tile inside it.
 */
function bannerSvg(w, h, opts, pw = w, ph = h) {
  const { markSize, markX, markY, title, titleSize, layout } = opts;
  const inner = iconSvg(512)
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>$/, '');
  const column = layout === 'column';
  const tagline = column ? 'AI on your computer' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="panel" x1="0" y1="0" x2="${column ? 0.6 : 1}" y2="1">
      <stop offset="0" stop-color="${TILE}"/>
      <stop offset="0.6" stop-color="${TILE}"/>
      <stop offset="1" stop-color="${TILE}"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#panel)"/>
  <rect width="${column ? 3 : 2}" height="${h}" fill="${RIM}"/>
  <g transform="translate(${markX} ${markY}) scale(${markSize / 512})">${inner}</g>
  <text x="${column ? w / 2 : markX + markSize + 14}" y="${column ? markY + markSize + 46 : h / 2 + titleSize * 0.36}"
        text-anchor="${column ? 'middle' : 'start'}" fill="${RIM}"
        font-family="Segoe UI, system-ui, sans-serif" font-size="${titleSize}" font-weight="600"
        letter-spacing="${(titleSize * 0.06).toFixed(2)}">${title}</text>
  ${tagline
      ? `<text x="${w / 2}" y="${markY + markSize + 76}" text-anchor="middle" fill="${RIM}"
        font-family="Segoe UI, system-ui, sans-serif" font-size="13">${tagline}</text>`
      : ''}
</svg>`;
}

module.exports = { iconSvg, bannerSvg };
