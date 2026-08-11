import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readStore, sanitizeProvider } from './provider-store.service.js';

const CLAUDE_ENV_KEYS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
];

function runtimeConflictReport(activeByTarget: Record<string, string>, providers: ReturnType<typeof sanitizeProvider>[]) {
  const result: Record<string, unknown> = {};
  const claudeActive = activeByTarget.claude;
  if (claudeActive) {
    const present = CLAUDE_ENV_KEYS.filter((key) => Boolean(process.env[key]));
    result.claude = {
      activeProviderId: claudeActive,
      inheritedVariablesPresent: present,
      appRuntimeOverlay: 'active provider overrides inherited variables',
      terminalNote: 'Already-open terminals and external switchers keep their own environment.',
      ccSwitchDetected: fs.existsSync(path.join(os.homedir(), '.cc-switch', 'cc-switch.db')),
    };
  } else {
    result.claude = {
      activeProviderId: null,
      inheritedVariablesPresent: CLAUDE_ENV_KEYS.filter((key) => Boolean(process.env[key])),
      appRuntimeOverlay: 'disabled; inherited machine configuration remains active',
      terminalNote: 'No Leoapi provider is active.',
      ccSwitchDetected: fs.existsSync(path.join(os.homedir(), '.cc-switch', 'cc-switch.db')),
    };
  }
  return result;
}

type DiagnosticsCliTool = Record<string, unknown>;

type DiagnosticsInput = {
  appVersion: string | null;
  cliTools: DiagnosticsCliTool[];
  switchProviders: ReturnType<typeof sanitizeProvider>[];
  activeByTarget: Record<string, string>;
};

/** Home-directory paths identify the user; collapse them for shareable output. */
export function redactHomePaths<T>(value: T, homeDir = os.homedir()): T {
  const serialized = JSON.stringify(value);
  const escapedHome = homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return JSON.parse(serialized.replace(new RegExp(escapedHome, 'g'), '~')) as T;
}

/**
 * Pure assembly so the redaction contract is unit-testable: everything the
 * report contains has already been through sanitizeProvider (API keys reduced
 * to a 4+4 mask) and home paths are collapsed to `~`.
 */
export function buildDiagnosticsReport(input: DiagnosticsInput, homeDir = os.homedir()) {
  return redactHomePaths({
    generatedAt: new Date().toISOString(),
    app: 'leocodebox',
    appVersion: input.appVersion,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    cliTools: input.cliTools,
    leoapi: {
      activeByTarget: input.activeByTarget,
      providers: input.switchProviders,
      runtime: runtimeConflictReport(input.activeByTarget, input.switchProviders),
    },
  }, homeDir);
}

export async function collectDiagnostics(appRoot: string, cliTools: DiagnosticsCliTool[]) {
  let appVersion: string | null = null;
  try {
    appVersion = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version || null;
  } catch {
    appVersion = null;
  }

  const store = await readStore();
  return buildDiagnosticsReport({
    appVersion,
    cliTools,
    switchProviders: store.providers.map(sanitizeProvider),
    activeByTarget: store.activeByTarget,
  });
}
