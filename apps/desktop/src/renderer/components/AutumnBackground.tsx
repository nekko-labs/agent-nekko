import React from 'react';

/** Decorative only: sparse, low-contrast shapes never intercept app input. */
export function AutumnBackground() {
  return (
    <div className="autumn-background" aria-hidden="true">
      {[8, 25, 43, 62, 79, 94].map((left, i) => (
        <svg key={left} className="autumn-leaf" viewBox="0 0 32 40" style={{ left: `${left}%`, animationDelay: `${-i * 7}s`, animationDuration: `${28 + i * 3}s` }}>
          <path d="M16 2C8 9 3 16 5 24c2 8 12 10 19 3S24 9 16 2Z" fill="currentColor" />
          <path d="M16 9v29m0-18-7-5m7 11 7-6" fill="none" stroke="var(--paper)" strokeWidth="1.5" />
        </svg>
      ))}
      {[12, 87].map((left) => (
        <svg key={left} className="autumn-pumpkin" viewBox="0 0 64 56" style={{ left: `${left}%` }}>
          <path d="M32 13c-2-6 1-10 5-12" fill="none" stroke="var(--accent-2)" strokeWidth="4" strokeLinecap="round" />
          <ellipse cx="21" cy="33" rx="17" ry="20" fill="currentColor" />
          <ellipse cx="43" cy="33" rx="17" ry="20" fill="currentColor" />
          <ellipse cx="32" cy="33" rx="13" ry="21" fill="currentColor" stroke="var(--paper)" strokeWidth="1.5" />
        </svg>
      ))}
    </div>
  );
}
