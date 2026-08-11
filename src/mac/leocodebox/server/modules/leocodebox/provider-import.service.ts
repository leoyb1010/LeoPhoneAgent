import fs from 'node:fs/promises';
import path from 'node:path';

import TOML from '@iarna/toml';

import { parseEnv } from './provider-apply.service.js';
import { homeDir, TARGETS, targetConfigPaths } from './provider-switch.config.js';
import {
  normalizeProvider,
  normalizeTarget,
  sanitizeIdPart,
  upsertProviderInStore,
} from './provider-store.service.js';
import type { ProviderStore, SwitchProvider, SwitchProviderInput } from './provider-store.service.js';
import { fileExists, readJsonFile, safeText } from './provider-switch.storage.js';

type JsonRecord = Record<string, unknown>;
type StringRecord = Record<string, string>;
type CcSwitchRow = {
  id: string | number;
  app_type: string;
  name?: string | null;
  settings_config?: string | null;
  notes?: string | null;
  is_current?: number | boolean;
};
type ImportedProviderDraft = SwitchProviderInput & { isCurrent?: boolean };

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function asStringRecord(value: unknown): StringRecord {
  const record = asRecord(value);
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, typeof item === 'string' ? item : ''])) as StringRecord;
}


async function importCurrentProviders(store: ProviderStore): Promise<SwitchProvider[]> {
  const imported: SwitchProvider[] = [];

  try {
    const [claudeSettingsPath] = targetConfigPaths('claude');
    const claudeSettings = await readJsonFile<JsonRecord | null>(claudeSettingsPath, null);
    const env = asStringRecord(claudeSettings?.env);
    if (Object.keys(env).length > 0) {
      const provider = normalizeProvider({
        id: 'claude-current',
        target: 'claude',
        name: 'Claude Code 当前配置',
        baseUrl: env.ANTHROPIC_BASE_URL || '',
        apiKey: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '',
        model: env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
        modelMapping: {
          sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || env.ANTHROPIC_MODEL || '',
          opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || env.ANTHROPIC_MODEL || '',
          haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || env.ANTHROPIC_MODEL || '',
        },
        wireApi: 'chat',
        category: 'imported',
      }, store.providers.find((item) => item.id === 'claude-current'));
      upsertProviderInStore(store, provider);
      imported.push(provider);
    }
  } catch {
    // Import is best-effort across tools.
  }

  try {
    const [codexAuthPath, codexConfigPath] = targetConfigPaths('codex');
    const auth = await readJsonFile<StringRecord>(codexAuthPath, {});
    let config = '';
    try {
      config = await fs.readFile(codexConfigPath, 'utf8');
    } catch {
      config = '';
    }
    const parsed = asRecord(config ? TOML.parse(config) : {});
    const activeProviderId = typeof parsed.model_provider === 'string' ? parsed.model_provider : '';
    const configuredProviders = asRecord(parsed.model_providers);
    const providerConfig = activeProviderId && configuredProviders[activeProviderId]
      ? asRecord(configuredProviders[activeProviderId])
      : null;
    const baseUrl = typeof providerConfig?.base_url === 'string' ? providerConfig.base_url : '';
    const model = typeof parsed.model === 'string' ? parsed.model : '';
    const wireApi = providerConfig?.wire_api === 'chat' ? 'chat' : 'responses';
    if (auth.OPENAI_API_KEY || baseUrl || model) {
      const provider = normalizeProvider({
        id: 'codex-current',
        target: 'codex',
        name: 'Codex 当前配置',
        baseUrl,
        apiKey: auth.OPENAI_API_KEY || '',
        model,
        wireApi,
        category: 'imported',
      }, store.providers.find((item) => item.id === 'codex-current'));
      upsertProviderInStore(store, provider);
      imported.push(provider);
    }
  } catch {
    // Import is best-effort across tools.
  }

  try {
    const [geminiEnvPath] = targetConfigPaths('gemini');
    const env = parseEnv(await fs.readFile(geminiEnvPath, 'utf8'));
    if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GEMINI_BASE_URL || env.GEMINI_MODEL) {
      const provider = normalizeProvider({
        id: 'gemini-current',
        target: 'gemini',
        name: 'Gemini 当前配置',
        baseUrl: env.GOOGLE_GEMINI_BASE_URL || '',
        apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '',
        model: env.GEMINI_MODEL || '',
        wireApi: 'chat',
        category: 'imported',
      }, store.providers.find((item) => item.id === 'gemini-current'));
      upsertProviderInStore(store, provider);
      imported.push(provider);
    }
  } catch {
    // Import is best-effort across tools.
  }

  try {
    const [opencodeConfigPath] = targetConfigPaths('opencode');
    const opencode = await readJsonFile<JsonRecord>(opencodeConfigPath, {});
    const configuredProviders = asRecord(opencode.provider);
    const configuredModel = typeof opencode.model === 'string' ? opencode.model : '';
    const modelSeparator = configuredModel.indexOf('/');
    const activeProviderId = modelSeparator > 0 ? configuredModel.slice(0, modelSeparator) : '';
    const activeProviderConfig = activeProviderId && configuredProviders[activeProviderId]
      && typeof configuredProviders[activeProviderId] === 'object'
      ? configuredProviders[activeProviderId]
      : null;
    const [fallbackProviderId, fallbackProviderConfig] = Object.entries(configuredProviders)[0] || [];
    const providerId = activeProviderConfig ? activeProviderId : fallbackProviderId;
    const providerConfig = asRecord(activeProviderConfig || fallbackProviderConfig);
    if (providerId && Object.keys(providerConfig).length > 0) {
      const providerOptions = asStringRecord(providerConfig.options);
      const modelFromConfig = activeProviderConfig && modelSeparator > 0
        ? configuredModel.slice(modelSeparator + 1)
        : Object.keys(asRecord(providerConfig.models))[0] || '';
      const provider = normalizeProvider({
        id: 'opencode-current',
        target: 'opencode',
        name: `OpenCode 当前配置 (${providerId})`,
        baseUrl: providerOptions.baseURL || '',
        apiKey: providerOptions.apiKey || '',
        model: modelFromConfig,
        wireApi: 'chat',
        category: 'imported',
      }, store.providers.find((item) => item.id === 'opencode-current'));
      upsertProviderInStore(store, provider);
      imported.push(provider);
    }
  } catch {
    // Import is best-effort across tools.
  }

  try {
    const [hermesConfigPath] = targetConfigPaths('hermes');
    const hermes = await fs.readFile(hermesConfigPath, 'utf8');
    const baseUrl = hermes.match(/^\s*base_url:\s*["']?([^"'\n]+)["']?/m)?.[1] || '';
    const apiKey = hermes.match(/^\s*api_key:\s*["']?([^"'\n]+)["']?/m)?.[1] || '';
    const model = hermes.match(/^\s*(?:default|model):\s*["']?([^"'\n]+)["']?/m)?.[1] || '';
    if (baseUrl || apiKey || model) {
      const provider = normalizeProvider({
        id: 'hermes-current',
        target: 'hermes',
        name: 'Hermes 当前配置',
        baseUrl,
        apiKey,
        model,
        wireApi: 'chat',
        category: 'imported',
      }, store.providers.find((item) => item.id === 'hermes-current'));
      upsertProviderInStore(store, provider);
      imported.push(provider);
    }
  } catch {
    // Import is best-effort across tools.
  }

  return imported;
}

function chooseActiveProvider(providers: SwitchProvider[], target: string, predicate: (provider: SwitchProvider) => boolean, preferredId?: string): string | null {
  const matches = providers.filter((provider) => provider.target === target && predicate(provider));
  return matches.find((provider) => provider.id === preferredId)?.id || matches[0]?.id || null;
}

function matchesCurrentValues(provider: SwitchProvider, current: { baseUrl: string; apiKey: string; model: string }): boolean {
  return safeText(provider.baseUrl, 800) === safeText(current.baseUrl, 800)
    && safeText(provider.apiKey, 4000) === safeText(current.apiKey, 4000)
    && safeText(provider.model, 200) === safeText(current.model, 200);
}

async function detectActiveByTarget(providers: SwitchProvider[], lastAppliedByTarget: Record<string, string> = {}): Promise<Record<string, string>> {
  const active: Record<string, string> = {};

  try {
    const [settingsPath] = targetConfigPaths('claude');
    const settings = await readJsonFile<JsonRecord | null>(settingsPath, null);
    const env = asStringRecord(settings?.env);
    if (Object.keys(env).length > 0) {
      const current = {
        baseUrl: env.ANTHROPIC_BASE_URL || '',
        apiKey: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '',
        model: env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
      };
      const match = chooseActiveProvider(
        providers,
        'claude',
        (provider) => matchesCurrentValues(provider, current),
        lastAppliedByTarget.claude,
      );
      if (match) active.claude = match;
    }
  } catch {
    // A single unreadable tool config must not hide the other active targets.
  }

  try {
    const [authPath, configPath] = targetConfigPaths('codex');
    const [auth, config] = await Promise.all([
      readJsonFile<StringRecord>(authPath, {}),
      fs.readFile(configPath, 'utf8').catch(() => ''),
    ]);
    let match = chooseActiveProvider(
      providers,
      'codex',
      (provider) => config.includes(`model_provider = "leocodebox_${sanitizeIdPart(provider.id)}"`),
      lastAppliedByTarget.codex,
    );
    if (!match && (auth.OPENAI_API_KEY || config)) {
      const current = {
        baseUrl: config.match(/^\s*base_url\s*=\s*["']([^"']+)["']/m)?.[1] || '',
        apiKey: auth.OPENAI_API_KEY || '',
        model: config.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1] || '',
      };
      match = chooseActiveProvider(
        providers,
        'codex',
        (provider) => matchesCurrentValues(provider, current),
        lastAppliedByTarget.codex,
      );
    }
    if (match) active.codex = match;
  } catch {
    // Best-effort detection.
  }

  try {
    const [geminiEnvPath] = targetConfigPaths('gemini');
    const env = parseEnv(await fs.readFile(geminiEnvPath, 'utf8'));
    const current = {
      baseUrl: env.GOOGLE_GEMINI_BASE_URL || '',
      apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '',
      model: env.GEMINI_MODEL || '',
    };
    const match = chooseActiveProvider(
      providers,
      'gemini',
      (provider) => matchesCurrentValues(provider, current),
      lastAppliedByTarget.gemini,
    );
    if (match) active.gemini = match;
  } catch {
    // Best-effort detection.
  }

  try {
    const [configPath] = targetConfigPaths('opencode');
    const config = await readJsonFile<JsonRecord>(configPath, {});
    const match = chooseActiveProvider(providers, 'opencode', (provider) => {
      const key = `leocodebox_${sanitizeIdPart(provider.id)}`;
      return Boolean(asRecord(config.provider)[key]) || String(config.model || '').startsWith(`${key}/`);
    }, lastAppliedByTarget.opencode);
    if (match) active.opencode = match;
  } catch {
    // Best-effort detection.
  }

  try {
    const [hermesConfigPath] = targetConfigPaths('hermes');
    const config = await fs.readFile(hermesConfigPath, 'utf8');
    const match = chooseActiveProvider(providers, 'hermes', (provider) => {
      const key = `leocodebox_${sanitizeIdPart(provider.id)}`;
      return config.includes(`provider: "${key}"`) || config.includes(`name: "${key}"`);
    }, lastAppliedByTarget.hermes);
    if (match) active.hermes = match;
  } catch {
    // Best-effort detection.
  }

  return active;
}


function mapCcSwitchRow(row: CcSwitchRow): ImportedProviderDraft | null {
  const target = normalizeTarget(row.app_type);
  if (!target) return null;

  let settings: JsonRecord = {};
  try {
    settings = JSON.parse(row.settings_config || '{}');
  } catch {
    settings = {};
  }
  const env = asStringRecord(settings.env);

  let baseUrl = '';
  let apiKey = '';
  let model = '';
  let modelMapping = null;

  if (target === 'claude') {
    baseUrl = env.ANTHROPIC_BASE_URL || '';
    apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
    model = env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || (typeof settings.model === 'string' ? settings.model : '');
    modelMapping = {
      sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || model,
      opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || model,
      haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || model,
    };
  } else if (target === 'codex') {
    const auth = asStringRecord(settings.auth);
    apiKey = auth.OPENAI_API_KEY || '';
    const configText = typeof settings.config === 'string' ? settings.config : '';
    baseUrl = configText.match(/^\s*base_url\s*=\s*["']([^"']+)["']/m)?.[1] || '';
    model = configText.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1] || '';
  } else if (target === 'gemini') {
    baseUrl = env.GOOGLE_GEMINI_BASE_URL || '';
    apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '';
    model = env.GOOGLE_GEMINI_MODEL || env.GEMINI_MODEL || '';
  } else {
    return null;
  }

  return {
    target,
    name: safeText(row.name || TARGETS[target].label, 120),
    baseUrl,
    apiKey,
    model,
    ...(modelMapping ? { modelMapping } : {}),
    wireApi: target === 'codex' ? 'responses' : 'chat',
    isCurrent: row.is_current === 1 || row.is_current === true,
    notes: safeText(row.notes || '', 2000),
  };
}

async function importCcSwitchProviders(store: ProviderStore): Promise<{ dbFound: boolean; imported: SwitchProvider[]; skipped: Array<{ id: string | number; appType: string; reason: string }> }> {
  const dbPath = path.join(homeDir(), '.cc-switch', 'cc-switch.db');
  if (!(await fileExists(dbPath))) {
    return { dbFound: false, imported: [], skipped: [] };
  }

  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let rows: CcSwitchRow[] = [];
  try {
    rows = db.prepare('SELECT id, app_type, name, settings_config, notes, is_current FROM providers').all() as CcSwitchRow[];
  } finally {
    db.close();
  }

  const imported: SwitchProvider[] = [];
  const skipped: Array<{ id: string | number; appType: string; reason: string }> = [];
  for (const row of rows) {
    const mapped = mapCcSwitchRow(row);
    if (!mapped) {
      skipped.push({ id: row.id, appType: row.app_type, reason: 'unsupported-target' });
      continue;
    }
    if (!mapped.apiKey && !mapped.baseUrl) {
      skipped.push({ id: row.id, appType: row.app_type, reason: 'no-credentials' });
      continue;
    }
    const id = `ccsw-${sanitizeIdPart(row.app_type)}-${sanitizeIdPart(row.id)}`;
    const provider = normalizeProvider(
      { ...mapped, id, category: 'imported-ccswitch' },
      store.providers.find((item) => item.id === id),
    );
    upsertProviderInStore(store, provider);
    // Do NOT set activeByTarget on import: "active" in leocodebox means the
    // provider's config was actually written to disk via apply. Import only
    // records the provider; the user applies it explicitly.
    imported.push(provider);
  }

  return { dbFound: true, imported, skipped };
}



/**
 * Adopt hand edits from the live config into the currently-active provider
 * record for `target`, so switching away doesn't lose them and switching back
 * restores what the user actually runs today.
 *
 * Deliberately narrow (lean write-back, not cc-switch's global snippet system):
 * - Only fires when the live config still points at the SAME destination we
 *   applied (base URL / managed marker match). If another tool rewrote the
 *   config to a different endpoint, we must NOT pollute the stored provider.
 * - claude/codex/gemini only. opencode/hermes configs are fully-managed
 *   fragments whose blocks are documented as "may be replaced" — hand edits
 *   there are not a supported surface.
 *
 * Mutates `store` in place; the caller persists. Returns true when anything
 * was adopted.
 */
async function adoptLiveProviderEdits(store: ProviderStore, target: string): Promise<boolean> {
  const activeId = store.activeByTarget?.[target];
  if (!activeId) return false;
  const provider = store.providers.find((item) => item.id === activeId);
  if (!provider) return false;

  const adopt = (updates: Partial<Pick<SwitchProvider, 'apiKey' | 'model'>> & { modelMapping?: Partial<SwitchProvider['modelMapping']> }): boolean => {
    let changed = false;
    if (updates.apiKey && updates.apiKey !== provider.apiKey) {
      provider.apiKey = safeText(updates.apiKey, 4000);
      changed = true;
    }
    if (updates.model && updates.model !== provider.model) {
      provider.model = safeText(updates.model, 200);
      changed = true;
    }
    if (updates.modelMapping) {
      for (const slot of ['sonnet', 'opus', 'haiku'] as const) {
        const value = safeText(updates.modelMapping[slot] || '', 240);
        if (value && value !== provider.modelMapping[slot]) {
          provider.modelMapping[slot] = value;
          changed = true;
        }
      }
    }
    if (changed) provider.updatedAt = new Date().toISOString();
    return changed;
  };

  try {
    if (target === 'claude') {
      const [settingsPath] = targetConfigPaths('claude');
      const settings = await readJsonFile<JsonRecord | null>(settingsPath, null);
      const env = asStringRecord(settings?.env);
      const liveBase = (env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '');
      if (!liveBase || liveBase !== provider.baseUrl) return false;
      return adopt({
        apiKey: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '',
        model: env.ANTHROPIC_MODEL || '',
        modelMapping: {
          sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
          opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || '',
          haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '',
        },
      });
    }

    if (target === 'codex') {
      const [authPath, configPath] = targetConfigPaths('codex');
      const [auth, config] = await Promise.all([
        readJsonFile<StringRecord>(authPath, {}),
        fs.readFile(configPath, 'utf8').catch(() => ''),
      ]);
      // Only adopt while our managed provider is still selected in config.toml
      // AND its base_url still matches the record — a hand-edited base_url
      // means the live key belongs to a different destination, and adopting it
      // would make a later re-apply send that key to the old host.
      if (!config.includes(`model_provider = "leocodebox_${sanitizeIdPart(provider.id)}"`)) return false;
      const liveBase = (config.match(/^\s*base_url\s*=\s*["']([^"']+)["']/m)?.[1] || '').replace(/\/+$/, '');
      if (liveBase && liveBase !== provider.baseUrl) return false;
      return adopt({
        apiKey: auth.OPENAI_API_KEY || '',
        model: config.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1] || '',
      });
    }

    if (target === 'gemini') {
      const [envPath] = targetConfigPaths('gemini');
      const env = parseEnv(await fs.readFile(envPath, 'utf8'));
      const liveBase = (env.GOOGLE_GEMINI_BASE_URL || '').replace(/\/+$/, '');
      if (!liveBase || liveBase !== provider.baseUrl) return false;
      return adopt({
        apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '',
        model: env.GEMINI_MODEL || '',
      });
    }
  } catch {
    // Write-back is best-effort: an unreadable config must never block a switch.
  }
  return false;
}

export { adoptLiveProviderEdits, detectActiveByTarget, importCcSwitchProviders, importCurrentProviders };
