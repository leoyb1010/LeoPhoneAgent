// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ThemeBrandLockup } from '../ThemeBrandLockup';
import type { Theme } from '@/themes/types';

afterEach(cleanup);

describe('ThemeBrandLockup', () => {
  it('keeps the approved fixed slots and renders both custom assets', () => {
    const theme: Theme = {
      id: 'custom-local',
      name: 'Custom',
      type: 'light',
      colors: {},
      brand: {
        icon: { src: 'icon.png' },
        logo: { src: 'logo.png' },
      },
    };
    const view = render(<ThemeBrandLockup theme={theme} testId="brand" />);
    expect(view.getByTestId('brand').className).toContain('h-[50px]');
    expect(view.getByTestId('brand').className).toContain('gap-[9px]');
    expect(view.getByTestId('brand-icon').className).toContain('h-[50px]');
    expect(view.getByTestId('brand-icon').className).toContain('w-[50px]');
    expect(view.getByTestId('brand-icon').className).toContain('rounded-full');
    expect(view.getByTestId('brand-logo').className).toContain('h-[37.5px]');
    expect(view.getByTestId('brand-logo').className).toContain('w-[110px]');
    expect(view.getByTestId('brand-icon').querySelector('img')?.getAttribute('src')).toBe(
      'icon.png',
    );
    expect(view.getByTestId('brand-logo').querySelector('img')?.getAttribute('src')).toBe(
      'logo.png',
    );
  });

  it('uses alpha-visible bounds instead of transparent canvas dimensions', () => {
    const theme: Theme = {
      id: 'trimmed-local',
      name: 'Trimmed',
      type: 'light',
      colors: {},
      brand: {
        logo: {
          src: 'logo.png',
          visibleBounds: {
            x: 100,
            y: 100,
            width: 800,
            height: 200,
            sourceWidth: 1000,
            sourceHeight: 500,
          },
        },
      },
    };
    const view = render(<ThemeBrandLockup theme={theme} testId="brand" />);
    const image = view.getByTestId('brand-logo').querySelector('img') as HTMLImageElement;
    expect(image.style.width).toBe('137.5px');
    expect(image.style.height).toBe('68.75px');
    expect(Number.parseFloat(image.style.left)).toBeCloseTo(-13.75);
    expect(Number.parseFloat(image.style.top)).toBeCloseTo(-8.75);
  });

  it('retries a failed custom asset when refresh supplies a new object with the same src', () => {
    const makeTheme = (): Theme => ({
      id: 'retry-local',
      name: 'Retry',
      type: 'light',
      colors: {},
      brand: { icon: { src: 'same-icon.png' } },
    });
    const view = render(<ThemeBrandLockup theme={makeTheme()} testId="brand" />);
    const customImage = view.getByTestId('brand-icon').querySelector('img') as HTMLImageElement;

    fireEvent.error(customImage);
    expect(view.getByTestId('brand-icon').querySelector('img')?.getAttribute('src')).not.toBe(
      'same-icon.png',
    );

    view.rerender(<ThemeBrandLockup theme={makeTheme()} testId="brand" />);
    expect(view.getByTestId('brand-icon').querySelector('img')?.getAttribute('src')).toBe(
      'same-icon.png',
    );
  });
});
