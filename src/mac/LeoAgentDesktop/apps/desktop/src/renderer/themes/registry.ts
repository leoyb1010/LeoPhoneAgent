import { atomOneLight } from './builtin/atom-one-light';
import { defaultDark } from './builtin/default-dark';
import { defaultLight } from './builtin/default-light';
import { eclipse } from './builtin/eclipse';
import { githubDark } from './builtin/github-dark';
import { materialOceanHC } from './builtin/material-ocean-hc';
import { monokaiPro } from './builtin/monokai-pro';
import { oneDarkPro } from './builtin/one-dark-pro';
import { solarizedLight } from './builtin/solarized-light';
import { cindyDark } from './builtin/cindy-dark';
import { cindyLight } from './builtin/cindy-light';
import { getLocalThemes } from './local-themes';
import {
  ATOM_ONE_LIGHT_ID,
  ECLIPSE_ID,
  GITHUB_DARK_ID,
  MATERIAL_OCEAN_HC_ID,
  MONOKAI_PRO_ID,
  ONE_DARK_PRO_ID,
  SOLARIZED_LIGHT_ID,
  THEME_DARK_ID,
  THEME_LIGHT_ID,
  CINDY_LIGHT_ID,
  CINDY_DARK_ID,
} from './theme-ids';
import type { Theme, ThemeType } from './types';

export const builtinThemes: Record<string, Theme> = {
  [defaultLight.id]: defaultLight,
  [atomOneLight.id]: atomOneLight,
  [solarizedLight.id]: solarizedLight,
  [cindyLight.id]: cindyLight,
  [cindyDark.id]: cindyDark,
  [defaultDark.id]: defaultDark,
  [eclipse.id]: eclipse,
  [oneDarkPro.id]: oneDarkPro,
  [githubDark.id]: githubDark,
  [monokaiPro.id]: monokaiPro,
  [materialOceanHC.id]: materialOceanHC,
};

// 历史 theme id → 当前 id 的迁移表。读 localStorage 时透明替换,让用户
// 之前选过的旧 id 自动落到新 id,不会因为更名静默回退到默认主题。
const LEGACY_THEME_ID_ALIASES: Readonly<Record<string, string>> = {
  'taptap-dark': ECLIPSE_ID,
};

function findThemeAnywhere(id: string): Theme | null {
  return builtinThemes[id] ?? getLocalThemes().find((theme) => theme.id === id) ?? null;
}

export function getTheme(id: string): Theme {
  const resolved = LEGACY_THEME_ID_ALIASES[id] ?? id;
  const theme = findThemeAnywhere(resolved);
  if (!theme) {
    throw new Error(`Unknown theme '${id}'.`);
  }
  return theme;
}

export function tryGetTheme(id: string | null | undefined): Theme | null {
  if (!id) {
    return null;
  }
  const resolved = LEGACY_THEME_ID_ALIASES[id] ?? id;
  return findThemeAnywhere(resolved);
}

export function listThemesByType(type: ThemeType): Theme[] {
  return [...Object.values(builtinThemes), ...getLocalThemes()].filter((theme) => theme.type === type);
}

export {
  ATOM_ONE_LIGHT_ID,
  ECLIPSE_ID,
  GITHUB_DARK_ID,
  MATERIAL_OCEAN_HC_ID,
  MONOKAI_PRO_ID,
  ONE_DARK_PRO_ID,
  SOLARIZED_LIGHT_ID,
  THEME_DARK_ID,
  THEME_LIGHT_ID,
  CINDY_LIGHT_ID,
  CINDY_DARK_ID,
};
