export const COMPLETION_ANIMATION_MS = 800;

/** Lives outside the card so completing it can remove the card immediately. */
export function celebrateCompletion(rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const effect = document.createElement('div');
  effect.className = 'completion-celebration';
  effect.setAttribute('aria-hidden', 'true');
  effect.style.left = `${rect.left + rect.width / 2}px`;
  effect.style.top = `${rect.top + rect.height / 2}px`;
  effect.innerHTML = '<svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path class="completion-check" pathLength="1" d="m12 20 5 5 11-12"/><circle class="completion-circle" pathLength="1" cx="20" cy="20" r="16"/></svg>';
  for (let i = 0; i < 6; i += 1) {
    const particle = document.createElement('i');
    const angle = (i * Math.PI) / 3;
    particle.style.setProperty('--confetti-x', `${Math.cos(angle) * 27}px`);
    particle.style.setProperty('--confetti-y', `${Math.sin(angle) * 27}px`);
    particle.style.setProperty('--confetti-turn', `${i * 60 + 90}deg`);
    effect.append(particle);
  }
  document.body.append(effect);
  window.setTimeout(() => effect.remove(), COMPLETION_ANIMATION_MS);
}
