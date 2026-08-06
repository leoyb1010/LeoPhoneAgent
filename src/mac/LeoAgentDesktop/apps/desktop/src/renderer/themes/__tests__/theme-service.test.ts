// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import { defaultDark } from '../builtin/default-dark';
import { defaultLight } from '../builtin/default-light';
import { themeService } from '../theme-service';

describe('ThemeService native control color scheme', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.classList.remove('dark');
    document.documentElement.style.removeProperty('color-scheme');
    document.getElementById('theme-vars')?.remove();
  });

  it('updates the native control color scheme when switching themes', () => {
    themeService.applyTheme(defaultDark);
    expect(document.documentElement.style.colorScheme).toBe('dark');

    themeService.applyTheme(defaultLight);
    expect(document.documentElement.style.colorScheme).toBe('light');
  });
});
