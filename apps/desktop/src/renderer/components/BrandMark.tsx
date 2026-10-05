import React from 'react';
import { useStore } from '../store.js';

/**
 * The Agent Nekko mark: an outline cat head, two ears with a soft curve of
 * forehead between them and a round jaw, nothing inside, drawn in one thin
 * stroke with sharp corners. The same path draws the app icon, the installer
 * art, the web manifest icon, the phone app's icons and the marketing site's
 * favicon (`apps/desktop/scripts/icon-art.cjs` holds the copy those pipelines
 * read, since they run outside the bundle); change one and change the other.
 */
export const BRAND_HEAD = 'M5 10l-1-6 5 3q3-1.1 6 0l5-3-1 6a7.4 7.4 0 0 1-14 0z';

export function BrandMark({ size = 24, className, title }: { size?: number; className?: string; title?: string }) {
  const autumn = useStore((s) => s.settings?.themePreset === 'autumn');
  // Heavier below 32 px (the title bar) so the line survives a 16 px render.
  const strokeWidth = size < 32 ? 2 : 1.5;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="butt"
      strokeLinejoin="miter"
      strokeMiterlimit={8}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <path d={BRAND_HEAD} />
      {autumn && (
        <g data-season="autumn" strokeWidth="0.8" strokeLinejoin="round">
          <path d="M12 7C9 6 9 3 10 1c3 1 5 3 2 6Z" fill="#dc842b" stroke="#bd6524" />
          <path d="m10.5 2.7 1.7 5" stroke="#744729" />
        </g>
      )}
    </svg>
  );
}
