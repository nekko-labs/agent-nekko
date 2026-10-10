/**
 * The Agent Nekko mark, as vector art: an outline cat head (two ears, a soft
 * curve of forehead between them, a round jaw, nothing inside) in one thin
 * stroke with sharp corners, on a deep tile, plus the installer banners that
 * reuse it. Pure
 * string-building with no renderer behind it, so anything that needs the mark
 * -- the desktop icon pipeline, the phone app's icons, the marketing site's
 * favicon -- draws from this one source instead of keeping its own copy of the
 * shape. The renderer's `components/BrandMark.tsx` holds the same two paths
 * for the in-app mark; change one and change the other.
 */

/* ── the mark ─────────────────────────────────────────────────────────────── */

const VIEWBOX = 512;
const INK = '#f2f1e9';
const RIM = '#a7c8ac';
/** The tile behind the mark, and what the installer panels are painted in. */
const TILE = '#101714';

/**
 * The head: two ears, a forehead that dips between them in a soft curve
 * rather than a flat bridge, a round jaw. Nothing inside the face. Drawn on a
 * 24-unit grid; the renderer's `BrandMark.tsx` carries the same path.
 */
const HEAD = 'M5 10l-1-6 5 3q3-1.1 6 0l5-3-1 6a7.4 7.4 0 0 1-14 0z';
/** The art's own bounds on that grid, for centring: x 4..20, y 4..17.4. */
const ART = { x: 4, y: 4, w: 16, h: 13.4 };

/**
 * The mark alone, drawn to fill `span` units of a square `box`, centred.
 * `size` is the final pixel size the art is chosen for: the line is thin at
 * icon size and heavier below 64 and 32 pixels, or it reads as a smudge in a
 * taskbar. Miter joins and flat caps keep the ear tips and notches sharp.
 */
function markGroup(size, box, span, color = INK) {
  const scale = span / Math.max(ART.w, ART.h);
  const tx = (box - ART.w * scale) / 2 - ART.x * scale;
  const ty = (box - ART.h * scale) / 2 - ART.y * scale;
  const stroke = size < 32 ? 2.0 : size < 64 ? 1.5 : 1.2;
  return `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(4)})" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="8">
      <path d="${HEAD}"/>
    </g>`;
}

/**
 * The app icon: the mark on a squircle tile with a rim light. Everything is
 * expressed in a 512 viewBox and scaled by the renderer, so the only
 * size-dependent decisions are how much detail survives.
 */
function iconSvg(size, px = size) {
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
    ${markGroup(size, VIEWBOX, 352)}
  </g>

  <!-- Rim light. A dark tile on a dark taskbar loses its own edge; a hairline of
       the accent gives it back without lightening the art. -->
  <rect x="3" y="3" width="506" height="506" rx="${corner - 3}" ry="${corner - 3}"
        fill="none" stroke="${RIM}" stroke-opacity="0.72" stroke-width="${rimWidth}"/>
</svg>`;
}

/**
 * The mark with nothing behind it, for places that paint their own ground:
 * Android's adaptive-icon layers (which keep the middle 66% safe), the phone
 * splash, and the monochrome variant. `inset` is the share of the box the art
 * may fill.
 */
function bareMarkSvg(px, { color = INK, inset = 0.72, background = 'none' } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}">
  ${background === 'none' ? '' : `<rect width="512" height="512" fill="${background}"/>`}
  ${markGroup(px, VIEWBOX, Math.round(VIEWBOX * inset), color)}
</svg>`;
}

/* ── the NSIS installer art ───────────────────────────────────────────────── */

/**
 * The Windows installer's header strip and sidebar panel. Same deep tile, same
 * mark, and the product's actual name.
 */
function bannerSvg(w, h, opts, pw = w, ph = h) {
  const { markSize, markX, markY, title, titleSize, layout } = opts;
  const inner = iconSvg(512)
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>$/, '');
  const column = layout === 'column';
  const tagline = column ? 'AI on your computer' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${TILE}"/>
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

module.exports = { iconSvg, bareMarkSvg, bannerSvg, TILE, INK, HEAD };
