import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';

import TOML from '@iarna/toml';

import { backupFile } from './provider-backup.service.js';
import { TARGETS, targetConfigPaths } from './provider-switch.config.js';
import { normalizeWireApi, sanitizeIdPart } from './provider-store.service.js';
import type { SwitchProvider } from './provider-store.service.js';
import {
  atomicWrite,
  captureFiles,
  readJsonFile,
  restoreFiles,
  writeJsonFile,
} from './provider-switch.storage.js';

type StatusError = Error & { statusCode?: number };
type JsonRecord = Record<string, unknown>;
type OpenCodeConfig = JsonRecord & { provider?: Record<string, unknown>; model?: string };

function toNodeError(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error ? error as NodeJS.ErrnoException : new Error(String(error));
}


const applyContext = new AsyncLocalStorage<{ preview: boolean }>();
async function maybeBackup(filePath: string): Promise<void> {
  if (!applyContext.getStore()?.preview) await backupFile(filePath);
}

function managedTomlBlocks(provider: SwitchProvider, includeProfile = true): { topLevel: string; tables: string } {
  const providerKey = `leocodebox_${sanitizeIdPart(provider.id)}`;
  const model = provider.model || 'gpt-5-codex';
  const baseUrl = provider.baseUrl || 'https://api.openai.com/v1';
  const wireApi = normalizeWireApi(provider.wireApi);
  const tomlString = (value: unknown): string => JSON.stringify(String(value));

  const topLevel = [
    '# BEGIN LEOCODEBOX SWITCH TOP LEVEL',
    '# Managed by leocodebox local provider switch. Edits inside this block may be replaced.',
    `model = ${tomlString(model)}`,
    `model_provider = ${tomlString(providerKey)}`,
    '# END LEOCODEBOX SWITCH TOP LEVEL',
    '',
  ].join('\n');

  const tables = [
    '# BEGIN LEOCODEBOX SWITCH TABLES',
    '# Managed by leocodebox local provider switch. Edits inside this block may be replaced.',
    '',
    `[model_providers.${providerKey}]`,
    `name = ${tomlString(provider.name || providerKey)}`,
    `base_url = ${tomlString(baseUrl)}`,
    'env_key = "OPENAI_API_KEY"',
    `wire_api = ${tomlString(wireApi)}`,
    '',
    ...(includeProfile ? [
      '[profiles.leocodebox]',
      `model_provider = ${tomlString(providerKey)}`,
      `model = ${tomlString(model)}`,
    ] : []),
    '# END LEOCODEBOX SWITCH TABLES',
    '',
  ].join('\n');
  return { topLevel, tables };
}

function removeManagedTomlBlock(config: unknown): string {
  return String(config || '')
    .replace(/\n?# BEGIN LEOCODEBOX SWITCH TOP LEVEL[\s\S]*?# END LEOCODEBOX SWITCH TOP LEVEL\n?/g, '\n')
    .replace(/\n?# BEGIN LEOCODEBOX SWITCH TABLES[\s\S]*?# END LEOCODEBOX SWITCH TABLES\n?/g, '\n')
    .replace(/\n?# BEGIN LEOCODEBOX SWITCH[\s\S]*?# END LEOCODEBOX SWITCH\n?/g, '\n')
    .trimEnd();
}

function removeManagedTopLevelKeys(config: unknown): string {
  const lines = String(config || '').split(/\r?\n/);
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const preambleEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;
  const preamble = lines.slice(0, preambleEnd).filter((line) => !/^\s*(model|model_provider)\s*=/.test(line));
  return [...preamble, ...lines.slice(preambleEnd)].join('\n').trimEnd();
}

async function applyClaudeProvider(provider: SwitchProvider): Promise<string[]> {
  const [settingsPath] = targetConfigPaths('claude');
  await maybeBackup(settingsPath);
  const settings = await readJsonFile<JsonRecord>(settingsPath, {});
  const env: Record<string, string> = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)
    ? { ...(settings.env as Record<string, string>) }
    : {};

  if (provider.baseUrl) env.ANTHROPIC_BASE_URL = provider.baseUrl;
  else delete env.ANTHROPIC_BASE_URL;
  if (provider.apiKey) {
    env.ANTHROPIC_AUTH_TOKEN = provider.apiKey;
    env.ANTHROPIC_API_KEY = provider.apiKey;
  } else {
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
  }
  const mappedModels = {
    ANTHROPIC_MODEL: provider.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: provider.modelMapping?.sonnet || provider.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: provider.modelMapping?.opus || provider.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: provider.modelMapping?.haiku || provider.model,
  };
  for (const [key, value] of Object.entries(mappedModels)) {
    if (value) env[key] = value;
    else delete env[key];
  }

  const nextSettings = {
    ...settings,
    env,
  };
  await writeJsonFile(settingsPath, nextSettings);
  return [settingsPath];
}

async function applyCodexProvider(provider: SwitchProvider): Promise<string[]> {
  const [authPath, configPath] = targetConfigPaths('codex');
  await maybeBackup(authPath);
  await maybeBackup(configPath);

  const auth = await readJsonFile<Record<string, string>>(authPath, {});
  if (provider.apiKey) {
    auth.OPENAI_API_KEY = provider.apiKey;
  } else {
    delete auth.OPENAI_API_KEY;
  }
  await writeJsonFile(authPath, auth);

  let existing = '';
  try {
    existing = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    if (toNodeError(error).code !== 'ENOENT') throw error;
  }
  const unmanaged = removeManagedTopLevelKeys(removeManagedTomlBlock(existing));
  const providerKey = `leocodebox_${sanitizeIdPart(provider.id)}`;
  const providerTablePattern = new RegExp(`^\\s*\\[model_providers\\.${providerKey}\\]\\s*$`, 'm');
  if (providerTablePattern.test(unmanaged)) {
    const error: StatusError = new Error(`Codex 配置中已存在 model_providers.${providerKey}，请修改 Leoapi 接口名称后重试。`);
    error.statusCode = 409;
    throw error;
  }
  const hasExistingLeocodeboxProfile = /^\s*\[profiles\.leocodebox\]\s*$/m.test(unmanaged);
  const managed = managedTomlBlocks(provider, !hasExistingLeocodeboxProfile);
  const nextConfig = `${managed.topLevel}${unmanaged ? `\n${unmanaged.trimStart()}\n` : '\n'}\n${managed.tables}`;
  TOML.parse(nextConfig);
  await atomicWrite(configPath, nextConfig);
  return [authPath, configPath];
}

export function parseEnv(content: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of String(content || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

function serializeEnvValue(value: unknown): string {
  const text = String(value ?? '');
  return /^[A-Za-z0-9_./:@%+,=-]*$/.test(text) ? text : JSON.stringify(text);
}

function updateManagedEnv(content: unknown, updates: Record<string, string | null>): string {
  const source = String(content || '');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = /\r?\n$/.test(source);
  const lines = source ? source.split(/\r?\n/) : [];
  if (hadTrailingNewline) lines.pop();
  const pending = new Map(Object.entries(updates));
  const output: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const key = match?.[1];
    if (!key || !pending.has(key)) {
      output.push(line);
      continue;
    }
    const value = pending.get(key);
    pending.delete(key);
    if (value != null && value !== '') {
      output.push(`${key}=${serializeEnvValue(value)}`);
    }
  }

  for (const [key, value] of pending) {
    if (value != null && value !== '') {
      output.push(`${key}=${serializeEnvValue(value)}`);
    }
  }
  return `${output.join(newline)}${output.length || hadTrailingNewline ? newline : ''}`;
}

async function applyGeminiProvider(provider: SwitchProvider): Promise<string[]> {
  const [envPath] = targetConfigPaths('gemini');
  await maybeBackup(envPath);
  let existing = '';
  try {
    existing = await fs.readFile(envPath, 'utf8');
  } catch (error) {
    if (toNodeError(error).code !== 'ENOENT') throw error;
  }

  const next = updateManagedEnv(existing, {
    GEMINI_API_KEY: provider.apiKey || null,
    GOOGLE_API_KEY: provider.apiKey || null,
    GOOGLE_GEMINI_BASE_URL: provider.baseUrl || null,
    GEMINI_MODEL: provider.model || null,
  });
  await atomicWrite(envPath, next);
  return [envPath];
}

function opencodeProviderFragment(provider: SwitchProvider): Record<string, unknown> {
  const model = provider.model || 'gpt-5-codex';
  const options: Record<string, string> = {};
  if (provider.baseUrl) options.baseURL = provider.baseUrl;
  if (provider.apiKey) options.apiKey = provider.apiKey;

  return {
    npm: provider.category === 'anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
    name: provider.name,
    options,
    models: {
      [model]: { name: model },
    },
  };
}

async function applyOpenCodeProvider(provider: SwitchProvider): Promise<string[]> {
  const [configPath] = targetConfigPaths('opencode');
  await maybeBackup(configPath);
  const config = await readJsonFile<OpenCodeConfig>(configPath, {
    $schema: 'https://opencode.ai/config.json',
  });
  const providerKey = `leocodebox_${sanitizeIdPart(provider.id)}`;
  if (!config.provider || typeof config.provider !== 'object' || Array.isArray(config.provider)) {
    config.provider = {};
  }
  config.provider[providerKey] = opencodeProviderFragment(provider);
  if (provider.model) {
    config.model = `${providerKey}/${provider.model}`;
  }
  await writeJsonFile(configPath, config);
  return [configPath];
}

function yamlString(value: unknown): string {
  return JSON.stringify(String(value || ''));
}

function managedHermesBlock(provider: SwitchProvider): string {
  const providerKey = `leocodebox_${sanitizeIdPart(provider.id)}`;
  const model = provider.model || 'anthropic/claude-sonnet-4-5';
  const baseUrl = provider.baseUrl || 'https://api.example.com/v1';
  return [
    '# BEGIN LEOCODEBOX SWITCH',
    '# Managed by leocodebox local provider switch. Edits inside this block may be replaced.',
    'model:',
    `  default: ${yamlString(model)}`,
    `  provider: ${yamlString(providerKey)}`,
    `  base_url: ${yamlString(baseUrl)}`,
    'custom_providers:',
    `  - name: ${yamlString(providerKey)}`,
    `    base_url: ${yamlString(baseUrl)}`,
    `    api_key: ${yamlString(provider.apiKey || '')}`,
    `    model: ${yamlString(model)}`,
    '# END LEOCODEBOX SWITCH',
    '',
  ].join('\n');
}

function removeManagedHermesBlock(config: unknown): string {
  return String(config || '').replace(/\n?# BEGIN LEOCODEBOX SWITCH[\s\S]*?# END LEOCODEBOX SWITCH\n?/g, '\n').trimEnd();
}

async function applyHermesProvider(provider: SwitchProvider): Promise<string[]> {
  const [configPath] = targetConfigPaths('hermes');
  await maybeBackup(configPath);
  let existing = '';
  try {
    existing = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    if (toNodeError(error).code !== 'ENOENT') throw error;
  }
  const unmanaged = removeManagedHermesBlock(existing);
  const nextConfig = `${unmanaged ? `${unmanaged}\n\n` : ''}${managedHermesBlock(provider)}`;
  await atomicWrite(configPath, nextConfig);
  return [configPath];
}

async function applyProvider(provider: SwitchProvider): Promise<string[]> {
  if (!TARGETS[provider.target]?.writable) {
    const error: StatusError = new Error(`${TARGETS[provider.target]?.label || provider.target} is listed but does not yet have a safe writer in leocodebox.`);
    error.statusCode = 501;
    throw error;
  }
  if (provider.target === 'claude') return applyClaudeProvider(provider);
  if (provider.target === 'codex') return applyCodexProvider(provider);
  if (provider.target === 'gemini') return applyGeminiProvider(provider);
  if (provider.target === 'opencode') return applyOpenCodeProvider(provider);
  if (provider.target === 'hermes') return applyHermesProvider(provider);
  const error: StatusError = new Error('Unsupported provider target.');
  error.statusCode = 400;
  throw error;
}

async function previewProviderChanges(provider: SwitchProvider): Promise<Array<{ filePath: string; before: string | null; after: string | null; changed: boolean }>> {
  const filePaths = targetConfigPaths(provider.target);
  const before = await captureFiles(filePaths);
  try {
    await applyContext.run({ preview: true }, () => applyProvider(provider));
    const after = await captureFiles(filePaths);
    const mask = (value: string | null): string | null => {
      if (!value || !provider.apiKey) return value;
      return value.split(provider.apiKey).join('••••••••');
    };
    return filePaths.map((filePath, index) => {
      const left = before[index]?.exists ? before[index]?.contents?.toString('utf8') ?? '' : null;
      const right = after[index]?.exists ? after[index]?.contents?.toString('utf8') ?? '' : null;
      return { filePath, before: mask(left), after: mask(right), changed: left !== right };
    });
  } finally {
    await restoreFiles(before);
  }
}

async function applyProviderTransactionally(provider: SwitchProvider, commit?: (changedFiles: string[]) => Promise<unknown> | unknown): Promise<string[]> {
  const filePaths = targetConfigPaths(provider.target);
  const snapshots = await captureFiles(filePaths);
  try {
    const changedFiles = await applyProvider(provider);
    if (commit) await commit(changedFiles);
    return changedFiles;
  } catch (error) {
    try {
      await restoreFiles(snapshots);
    } catch (restoreError) {
      const original = error instanceof Error ? error : new Error(String(error));
      original.message = `${original.message} Rollback also failed: ${toNodeError(restoreError).message}`;
      error = original;
    }
    throw error;
  }
}


export { applyProviderTransactionally, previewProviderChanges };
