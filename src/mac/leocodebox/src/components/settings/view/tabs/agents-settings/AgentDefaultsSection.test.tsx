import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import zhSettings from '../../../../../i18n/locales/zh-CN/settings.json';
import type { AppPreferences } from '../../../../../contexts/PreferencesContext';

import AgentDefaultsSection from './AgentDefaultsSection';

const preferences: AppPreferences = {
  language: 'zh-CN', defaultProvider: 'codex', defaultModel: 'fixture-model', permissionMode: 'default',
  density: 'compact', accent: 'green', reduceMotion: false,
};

test('new-task defaults save through the existing preference keys and stay accessible by label', async () => {
  const i18n = createInstance();
  await i18n.init({ lng: 'zh-CN', resources: { 'zh-CN': { settings: zhSettings } }, initImmediate: false });
  const writes: Array<Partial<AppPreferences>> = [];
  const renderer = TestRenderer.create(<I18nextProvider i18n={i18n}><AgentDefaultsSection preferences={preferences} saving={false} onUpdate={async (next) => { writes.push(next); }} /></I18nextProvider>);
  try {
    const agent = renderer.root.findByProps({ 'aria-label': zhSettings.appearanceSettings.workspace.defaultAgent });
    const model = renderer.root.findByProps({ 'aria-label': zhSettings.appearanceSettings.workspace.defaultModel });
    const permission = renderer.root.findByProps({ 'aria-label': zhSettings.appearanceSettings.workspace.defaultPermission });
    await act(async () => agent.props.onChange({ target: { value: 'claude' } }));
    await act(async () => model.props.onBlur({ target: { value: 'new-model' } }));
    await act(async () => permission.props.onChange({ target: { value: 'acceptEdits' } }));
    assert.deepEqual(writes, [{ defaultProvider: 'claude' }, { defaultModel: 'new-model' }, { permissionMode: 'acceptEdits' }]);
  } finally { renderer.unmount(); }
});

test('execution defaults belong to Agent settings and not Appearance', () => {
  const agents = readFileSync('src/components/settings/view/tabs/agents-settings/AgentsSettingsTab.tsx', 'utf8');
  const appearance = readFileSync('src/components/settings/view/tabs/AppearanceSettingsTab.tsx', 'utf8');
  assert.match(agents, /<AgentDefaultsSection/);
  assert.doesNotMatch(appearance, /agentDefaultsTitle|defaultAgent|defaultPermission|defaultModel/);
});
