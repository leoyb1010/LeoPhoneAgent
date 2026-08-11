/**
 * Motion helpers that honor the user's reduce-motion preference.
 *
 * CSS transitions/animations are already neutralized globally when reduce-motion
 * is on (index.css), but `scrollIntoView({ behavior: 'smooth' })` passes its
 * behavior as a JS argument that CSS cannot override — so those calls must read
 * the preference themselves. PreferencesContext mirrors the setting onto
 * `document.documentElement.dataset.reduceMotion`, and the OS media query is the
 * fallback, so this stays dependency-free.
 */

export function prefersReducedMotion(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset.reduceMotion === 'true') {
    return true;
  }
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** ScrollBehavior for scrollIntoView — 'auto' (instant) when reduce-motion is on. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}
