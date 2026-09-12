import assert from 'node:assert/strict';
import test from 'node:test';

import { createInstance } from 'i18next';

import enSettings from '../../i18n/locales/en/settings.json';
import zhSettings from '../../i18n/locales/zh-CN/settings.json';

import { getSettingsPaletteItems, NAV_TABS } from './paletteNavigation';

test('settings commands use the same localized labels as the settings sidebar', async () => {
  const i18n = createInstance();
  await i18n.init({ lng: 'zh-CN', resources: { 'zh-CN': { settings: zhSettings }, en: { settings: enSettings } }, initImmediate: false });
  const storage = getSettingsPaletteItems(i18n.t).find((entry) => entry.id === 'storage');
  assert.equal(storage?.label, zhSettings.mainTabs.storage);
  const agents = getSettingsPaletteItems(i18n.t).find((entry) => entry.id === 'agents');
  assert.equal(agents?.label, zhSettings.mainTabs.agents);
  await i18n.changeLanguage('en');
  assert.equal(getSettingsPaletteItems(i18n.t).find((entry) => entry.id === 'storage')?.label, enSettings.mainTabs.storage);
});

test('Treasury has its own global destination and discoverable Chinese and English terms', () => {
  const treasury = NAV_TABS.find((entry) => entry.id === 'collections');
  assert.ok(treasury);
  for (const term of ['藏宝阁', '收藏', 'treasury']) assert.ok(treasury.keywords.includes(term));
});
