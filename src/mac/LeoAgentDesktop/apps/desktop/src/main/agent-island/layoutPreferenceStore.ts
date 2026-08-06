import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '../logger.js';
import type { AgentIslandLayoutPreference } from './geometry.js';

const log = createLogger('agent-island:layout-store');

interface StoredLayoutPreference {
  centerXRatio?: number;
  compactContentWidth?: number;
  expandedContentWidth?: number;
}

interface AgentIslandLayoutSettings {
  displays: Record<string, StoredLayoutPreference>;
}

const DEFAULTS: AgentIslandLayoutSettings = {
  displays: {},
};

let cached: AgentIslandLayoutSettings | null = null;

/**
 * Stores per-display Agent Island placement and sizing outside the renderer so
 * the native helper can restore the same compact/expanded geometry after restart.
 */
function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'agent-island-layout-settings.json');
}

function normalize(raw: unknown): AgentIslandLayoutSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const record = raw as Record<string, unknown>;
  const rawDisplays = record.displays;
  if (!rawDisplays || typeof rawDisplays !== 'object') return { ...DEFAULTS };
  const displays: Record<string, StoredLayoutPreference> = {};
  for (const [displayId, value] of Object.entries(rawDisplays as Record<string, unknown>)) {
    const normalized = normalizePreference(value);
    if (normalized) displays[displayId] = normalized;
  }
  return { displays };
}

function normalizePreference(raw: unknown): StoredLayoutPreference | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const preference: StoredLayoutPreference = {};
  if (typeof record.centerXRatio === 'number' && Number.isFinite(record.centerXRatio)) {
    preference.centerXRatio = record.centerXRatio;
  }
  if (typeof record.compactContentWidth === 'number' && Number.isFinite(record.compactContentWidth)) {
    preference.compactContentWidth = record.compactContentWidth;
  }
  if (typeof record.expandedContentWidth === 'number' && Number.isFinite(record.expandedContentWidth)) {
    preference.expandedContentWidth = record.expandedContentWidth;
  }
  return Object.keys(preference).length > 0 ? preference : null;
}

function readSettings(): AgentIslandLayoutSettings {
  if (cached) return cached;
  const file = settingsFilePath();
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      cached = normalize(parsed);
      return cached;
    }
  } catch (error) {
    log.warn('agent island layout settings read failed; falling back to defaults', {
      error: error instanceof Error ? error.message : String(error),
      path: file,
    });
    try {
      fs.unlinkSync(file);
    } catch {
      // no-op
    }
  }
  cached = { ...DEFAULTS };
  return cached;
}

function writeSettings(next: AgentIslandLayoutSettings): void {
  const file = settingsFilePath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  cached = next;
}

export function readAgentIslandLayoutPreferences(): Map<number, AgentIslandLayoutPreference> {
  const settings = readSettings();
  const preferences = new Map<number, AgentIslandLayoutPreference>();
  for (const [displayIdText, preference] of Object.entries(settings.displays)) {
    const displayId = Number(displayIdText);
    if (!Number.isFinite(displayId)) continue;
    preferences.set(displayId, { ...preference });
  }
  return preferences;
}

export function writeAgentIslandLayoutPreference(
  displayId: number,
  preference: AgentIslandLayoutPreference,
): void {
  if (!Number.isFinite(displayId)) return;
  const normalized = normalizePreference(preference);
  const next: AgentIslandLayoutSettings = {
    displays: { ...readSettings().displays },
  };
  const key = String(displayId);
  if (normalized) {
    next.displays[key] = normalized;
  } else {
    delete next.displays[key];
  }
  writeSettings(next);
}
