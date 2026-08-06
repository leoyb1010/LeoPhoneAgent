/**
 * useIsDarkMode — observe the live `dark` class on <html>.
 *
 * The app's ThemeProvider toggles `<html class="dark">` based on the user's
 * theme preference (or OS preference when set to 'system'). Editor surfaces
 * need a boolean theme signal, and the value must stay in sync if the user
 * flips the toggle while a surface is mounted.
 *
 * MutationObserver on the `class` attribute is the simplest way to track
 * this without coupling editor surfaces to the project's specific theme store.
 */

import { useEffect, useState } from 'react';

export function useIsDarkMode(): boolean {
  const [isDark, setIsDark] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  );

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setIsDark(root.classList.contains('dark'));
    });
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}
