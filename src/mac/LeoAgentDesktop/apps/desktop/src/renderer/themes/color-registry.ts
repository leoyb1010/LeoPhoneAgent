import type {
  ColorContribution,
  ColorDefaults,
  ColorIdentifier,
  ColorValue,
  ThemeType,
} from './types';

export class ColorRegistry {
  private readonly colors: ColorContribution[] = [];
  private readonly colorsById = new Map<ColorIdentifier, ColorContribution>();

  registerColor(
    id: ColorIdentifier,
    defaults: ColorDefaults,
    description: string,
  ): ColorIdentifier {
    if (this.colorsById.has(id)) {
      throw new Error(`Color '${id}' is already registered.`);
    }

    const contribution: ColorContribution = { id, defaults, description };
    this.colors.push(contribution);
    this.colorsById.set(id, contribution);
    return id;
  }

  resolveDefault(id: ColorIdentifier, base: ThemeType): ColorValue | null {
    return this.colorsById.get(id)?.defaults[base] ?? null;
  }

  getColors(): ColorContribution[] {
    return [...this.colors];
  }
}

export const colorRegistry = new ColorRegistry();

export function registerColor(
  id: ColorIdentifier,
  defaults: ColorDefaults,
  description: string,
): ColorIdentifier {
  return colorRegistry.registerColor(id, defaults, description);
}
