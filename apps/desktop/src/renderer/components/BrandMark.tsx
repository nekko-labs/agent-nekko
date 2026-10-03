import React from 'react';

/**
 * The Agent Nekko mark: an outline cat head, drawn in one stroke weight. The
 * same paths draw the app icon, the installer art, the web manifest icon and
 * the marketing site's favicon (`apps/desktop/scripts/icon-art.cjs` holds the
 * copy those pipelines read, since they run outside the bundle); change one
 * and change the other.
 */
export const BRAND_HEAD = 'M5 10l-1-6 5 3h6l5-3-1 6a7 7 0 0 1-14 0z';
export const BRAND_FACE = 'M9.5 12.5h.01M14.5 12.5h.01M10.6 14.6c.8.7 2 .7 2.8 0';

export function BrandMark({ size = 24, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <path d={BRAND_HEAD} />
      <path d={BRAND_FACE} strokeWidth="2" />
    </svg>
  );
}
