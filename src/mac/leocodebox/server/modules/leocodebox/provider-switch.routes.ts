import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import express from 'express';

import { appConfigDb } from '@/modules/database/index.js';

import { PROVIDER_TEMPLATES } from '../../shared/provider-templates.js';


import { applyProviderTransactionally, previewProviderChanges } from './provider-apply.service.js';
import {
  clearAutoFailoverRecord,
  getHealthSnapshot,
  runHealthTick,
  runManualFailover,
} from './provider-health.service.js';
import {
  adoptLiveProviderEdits,
  detectActiveByTarget,
  importCcSwitchProviders,
  importCurrentProviders,
} from './provider-import.service.js';
import {
  allowedConfigDestinations,
  backupFile,
  configStatus,
  defaultSnapshotPath,
  ensureDefaultSnapshot,
  readDefaultSnapshot,
  resolveBackupDestination,
} from './provider-backup.service.js';
import {
  benchmarkProviderModel,
  discoverProviderModels,
  testProviderConnectivity,
  testProviderEndpoints,
  validateProviderBaseUrl,
} from './provider-discovery.service.js';
import {
  appendEndpointSamples,
  endpointLatencyP95,
  normalizeEndpointUrls,
  normalizeHealthMonitorSettings,
  normalizeModelMapping,
  normalizeProvider,
  normalizeTarget,
  readStore,
  sanitizeIdPart,
  sanitizeProvider,
  upsertProviderInStore,
  withSwitchMutation,
  writeStore,
} from './provider-store.service.js';
import type { SwitchProvider } from './provider-store.service.js';
import {
  displayConfigPath,
  providerStorePath,
  switchDir,
  TARGETS,
  targetConfigPaths,
} from './provider-switch.config.js';
import {
  atomicWrite,
  captureFiles,
  fileExists,
  nowIso,
  restoreFiles,
  safeText,
} from './provider-switch.storage.js';


const router = express.Router();
const SWITCH_PROFILES_KEY = 'provider_switch_profiles';
type ProviderSwitchProfile = { name: string; providerId: string; target: string; modelMapping?: Record<string, string>; createdAt: string; updatedAt: string };
function readSwitchProfiles(): ProviderSwitchProfile[] {
  try {
    const parsed = JSON.parse(appConfigDb.get(SWITCH_PROFILES_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function writeSwitchProfiles(profiles: ProviderSwitchProfile[]): void {
  appConfigDb.set(SWITCH_PROFILES_KEY, JSON.stringify(profiles.slice(-50)));
}

type StatusError = Error & { statusCode?: number };
type BackupRecord = {
  path: string;
  relativePath: string;
  targetPath: string | null;
  targetId: string | null;
  targetLabel: string;
  fileName: string;
  createdAt: string;
  size: number;
};

function toNodeError(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error ? error as NodeJS.ErrnoException : new Error(String(error));
}






router.use('/switch', (req, res, next) => {
  if (process.env.LEOCODEBOX_LOCAL_ONLY === '1' || process.env.LEOCODEBOX_TEST_HOME) {
    next();
    return;
  }
  res.status(403).json({ success: false, error: 'Provider switching is available only in local-only mode.' });
});

router.get('/switch/status', async (_req, res, next) => {
  try {
    const store = await readStore();
    const activeByTarget = await detectActiveByTarget(store.providers, store.activeByTarget);
    await Promise.all(Object.keys(activeByTarget).map((target) => (
      TARGETS[target]?.writable ? ensureDefaultSnapshot(target, store) : Promise.resolve()
    )));
    const nativeAvailableByTarget = Object.fromEntries(await Promise.all(
      Object.values(TARGETS).map(async (target) => [
        target.id,
        target.writable && await fileExists(defaultSnapshotPath(target.id)),
      ]),
    ));
    res.json({
      success: true,
      targets: configStatus(),
      presets: PROVIDER_TEMPLATES,
      activeByTarget,
      nativeAvailableByTarget,
      lastAppliedByTarget: store.activeByTarget,
      providers: store.providers.map(sanitizeProvider),
      storePath: providerStorePath(),
      // Shell exports (e.g. left behind by another switcher like cc-switch)
      // outrank config files for TERMINAL sessions — surface them so a switch
      // that "does nothing in the terminal" is explainable at a glance.
      // In-app sessions are covered by the active-provider env overlay
      // (claude/codex); gemini has no in-app runtime, so the warning is the
      // only guardrail there. opencode reads OPENCODE_CONFIG-style redirects
      // through the same env-aware path resolution we write with, so it needs
      // no entry here.
      shellOverrides: {
        claude: process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY
          ? {
            ...(process.env.ANTHROPIC_BASE_URL ? { baseUrl: process.env.ANTHROPIC_BASE_URL } : {}),
            ...(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY ? { apiKeyPresent: true } : {}),
          }
          : null,
        codex: process.env.OPENAI_API_KEY ? { apiKeyPresent: true } : null,
        gemini: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GEMINI_BASE_URL
          ? {
            ...(process.env.GOOGLE_GEMINI_BASE_URL ? { baseUrl: process.env.GOOGLE_GEMINI_BASE_URL } : {}),
            ...(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? { apiKeyPresent: true } : {}),
          }
          : null,
      },
      health: getHealthSnapshot(store.healthMonitor),
    });
  } catch (error) {
    next(error);
  }
});


function validateProviderDestinations(provider: SwitchProvider): void {
  if (provider.baseUrl) validateProviderBaseUrl(provider.baseUrl);
  for (const endpoint of normalizeEndpointUrls(provider, provider, provider.baseUrl)) {
    validateProviderBaseUrl(endpoint);
  }
}

function providerCredentialDestinationFingerprint(provider: SwitchProvider): string {
  const endpoints = normalizeEndpointUrls(provider, provider, provider.baseUrl)
    .map((endpoint) => validateProviderBaseUrl(endpoint))
    .sort();
  return crypto.createHash('sha256').update(JSON.stringify({
    target: provider.target,
    baseUrl: provider.baseUrl ? validateProviderBaseUrl(provider.baseUrl) : '',
    wireApi: provider.wireApi,
    endpoints,
  })).digest('hex');
}

function providerDiscoveryConfigFingerprint(provider: SwitchProvider): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    target: provider.target,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    wireApi: provider.wireApi,
  })).digest('hex');
}

function scheduleProviderModelDiscovery(provider: SwitchProvider, timeoutMs: unknown): void {
  const providerId = provider.id;
  const expectedFingerprint = providerDiscoveryConfigFingerprint(provider);
  void discoverProviderModels(provider, { bypassCache: true, timeoutMs }).then(async (discovery) => {
    await withSwitchMutation(async () => {
      const store = await readStore();
      const latestProvider = store.providers.find((item) => item.id === providerId);
      if (!latestProvider || providerDiscoveryConfigFingerprint(latestProvider) !== expectedFingerprint) return;
      latestProvider.discoveredModels = discovery.models;
      latestProvider.modelDiscovery = {
        endpoint: discovery.endpoint,
        updatedAt: discovery.cache.updatedAt,
        expiresAt: discovery.cache.expiresAt,
        latencyMs: discovery.latencyMs,
        httpStatus: discovery.httpStatus,
        modelCount: discovery.models.length,
        lastSuccessAt: nowIso(),
        lastErrorAt: null,
      };
      latestProvider.modelDiscoveryError = '';
      if (!latestProvider.model && discovery.models[0]) {
        latestProvider.model = discovery.models[0];
        latestProvider.modelMapping = normalizeModelMapping({}, latestProvider, latestProvider.model);
      }
      latestProvider.updatedAt = nowIso();
      await writeStore(store);
    });
  }).catch(async (error) => {
    console.warn(`Provider model discovery failed for ${providerId}:`, error);
    await withSwitchMutation(async () => {
      const store = await readStore();
      const latestProvider = store.providers.find((item) => item.id === providerId);
      if (!latestProvider || providerDiscoveryConfigFingerprint(latestProvider) !== expectedFingerprint) return;
      latestProvider.modelDiscoveryError = safeText(error?.message || '未知错误', 500);
      latestProvider.modelDiscovery = {
        ...(latestProvider.modelDiscovery || {}),
        lastErrorAt: nowIso(),
      };
      latestProvider.updatedAt = nowIso();
      await writeStore(store);
    });
  });
}


router.get('/switch/profiles', (_req, res) => {
  res.json({ success: true, profiles: readSwitchProfiles() });
});

router.post('/switch/profiles', async (req, res, next) => {
  try {
    const name = safeText(req.body?.name, 80);
    const providerId = safeText(req.body?.providerId, 120);
    if (!name || !providerId) return res.status(400).json({ success: false, error: 'name and providerId are required.' });
    const store = await readStore();
    const provider = store.providers.find((item) => item.id === providerId);
    if (!provider) return res.status(404).json({ success: false, error: 'Provider not found.' });
    const profiles = readSwitchProfiles().filter((profile) => profile.name !== name);
    profiles.push({ name, providerId, target: provider.target, modelMapping: provider.modelMapping, createdAt: nowIso(), updatedAt: nowIso() });
    writeSwitchProfiles(profiles);
    res.json({ success: true, profile: profiles.at(-1) });
  } catch (error) { next(error); }
});

router.delete('/switch/profiles/:name', (req, res) => {
  const name = safeText(req.params.name, 80);
  writeSwitchProfiles(readSwitchProfiles().filter((profile) => profile.name !== name));
  res.json({ success: true });
});

router.post('/switch/profiles/:name/apply', async (req, res, next) => {
  try {
    const profile = readSwitchProfiles().find((item) => item.name === safeText(req.params.name, 80));
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found.' });
    const store = await readStore();
    const provider = store.providers.find((item) => item.id === profile.providerId);
    if (!provider) return res.status(404).json({ success: false, error: 'Profile provider not found.' });
    const profileProvider: SwitchProvider = { ...provider, modelMapping: normalizeModelMapping(profile.modelMapping || {}, provider, provider.model) };
    const changedFiles = await applyProviderTransactionally(profileProvider, async () => {
      provider.modelMapping = profileProvider.modelMapping;
      store.activeByTarget[provider.target] = provider.id;
      provider.lastAppliedAt = nowIso();
      provider.updatedAt = nowIso();
      await writeStore(store);
    });
    res.json({ success: true, profile, provider: sanitizeProvider(provider), changedFiles, activeByTarget: store.activeByTarget });
  } catch (error) { next(error); }
});

router.post('/switch/providers', async (req, res, next) => {
  try {
    const { provider, reapplied, activeModel } = await withSwitchMutation(async () => {
      const store = await readStore();
      const existing = req.body?.id ? store.providers.find((item) => item.id === req.body.id) : null;
      const savedProvider = normalizeProvider(req.body, existing);
      validateProviderDestinations(savedProvider);
      if (existing?.apiKey && savedProvider.apiKey === existing.apiKey
        && providerCredentialDestinationFingerprint(savedProvider) !== providerCredentialDestinationFingerprint(existing)) {
        const error: StatusError = new Error('修改请求地址、协议或端点时必须重新输入 API Key。');
        error.statusCode = 400;
        throw error;
      }
      upsertProviderInStore(store, savedProvider);
      await writeStore(store);

      // Editing the provider that is currently live for its target must
      // rewrite the agent config immediately — otherwise the store and the
      // real config silently diverge and the edit "does not take effect".
      if (store.activeByTarget[savedProvider.target] === savedProvider.id) {
        await ensureDefaultSnapshot(savedProvider.target, store);
        await applyProviderTransactionally(savedProvider, async () => {
          savedProvider.lastAppliedAt = nowIso();
          savedProvider.updatedAt = nowIso();
          upsertProviderInStore(store, savedProvider);
          await writeStore(store);
        });
        return {
          provider: savedProvider,
          reapplied: true,
          activeModel: savedProvider.target === 'opencode' && savedProvider.model
            ? `leocodebox_${sanitizeIdPart(savedProvider.id)}/${savedProvider.model}`
            : savedProvider.model || null,
        };
      }
      return { provider: savedProvider, reapplied: false, activeModel: null };
    });

    const shouldDiscover = req.body?.autoDiscover === true && provider.baseUrl && provider.apiKey;
    res.json({
      success: true,
      provider: sanitizeProvider(provider),
      reapplied,
      activeModel,
      discovery: shouldDiscover ? 'pending' : null,
      warning: null,
    });
    if (shouldDiscover) scheduleProviderModelDiscovery(provider, req.body?.timeoutMs);
  } catch (error) {
    next(error);
  }
});

router.get('/switch/providers/:id/preview', async (req, res, next) => {
  try {
    const store = await readStore();
    const provider = store.providers.find((item) => item.id === req.params.id);
    if (!provider) return res.status(404).json({ success: false, error: 'Provider not found.' });
    const diff = (await previewProviderChanges(provider)).map((entry) => ({
      ...entry,
      filePath: displayConfigPath(entry.filePath),
    }));
    res.json({
      success: true,
      provider: sanitizeProvider(provider),
      target: provider.target,
      currentlyActive: store.activeByTarget[provider.target] === provider.id,
      files: diff.map((entry) => entry.filePath),
      diff,
      note: 'Preview was rendered with the same writer used by Apply; secrets are masked and files were restored afterwards.',
    });
  } catch (error) { next(error); }
});

router.post('/switch/providers/:id/apply', async (req, res, next) => {
  try {
    await withSwitchMutation(async () => {
      const store = await readStore();
      const provider = store.providers.find((item) => item.id === req.params.id);
      if (!provider) {
        res.status(404).json({ success: false, error: 'Provider not found.' });
        return;
      }

      const mappedModels = Object.values(provider.modelMapping || {}).filter((model): model is string => Boolean(model));
      if (mappedModels.length > 0 && provider.baseUrl && !process.env.LEOCODEBOX_TEST_HOME) {
        const discovery = await discoverProviderModels(provider, { bypassCache: true, timeoutMs: req.body?.timeoutMs });
        provider.discoveredModels = discovery.models;
        provider.modelDiscovery = {
          latencyMs: discovery.latencyMs,
          httpStatus: discovery.httpStatus,
          modelCount: discovery.models.length,
          lastSuccessAt: nowIso(),
          lastErrorAt: null,
        };
        provider.updatedAt = nowIso();
        await writeStore(store);
      }
      if (mappedModels.length > 0 && provider.discoveredModels.length > 0) {
        const available = new Set(provider.discoveredModels);
        const missing = mappedModels.filter((model) => !available.has(model));
        if (missing.length > 0) {
          const error: StatusError = new Error(`模型映射校验失败：网关未发现 ${missing.join(', ')}。`);
          error.statusCode = 409;
          throw error;
        }
      }
      await ensureDefaultSnapshot(provider.target, store);
      // Switching away? First fold any hand edits the user made to the live
      // config back into the outgoing provider record, so switching back later
      // restores what they actually run today (lean write-back).
      if (store.activeByTarget[provider.target] && store.activeByTarget[provider.target] !== provider.id) {
        await adoptLiveProviderEdits(store, provider.target);
      }
      const changedFiles = await applyProviderTransactionally(provider, async () => {
        store.activeByTarget[provider.target] = provider.id;
        provider.lastAppliedAt = nowIso();
        provider.updatedAt = nowIso();
        await writeStore(store);
      });
      // A manual apply supersedes any auto-failover breadcrumb for this target.
      clearAutoFailoverRecord(provider.target);

      res.json({
        success: true,
        provider: sanitizeProvider(provider),
        activeByTarget: store.activeByTarget,
        activeModel: provider.target === 'opencode' && provider.model
          ? `leocodebox_${sanitizeIdPart(provider.id)}/${provider.model}`
          : provider.model || null,
        changedFiles,
      });
    });
  } catch (error) {
    next(error);
  }
});

router.post('/switch/targets/:target/restore-default', async (req, res, next) => {
  try {
    await withSwitchMutation(async () => {
      const target = normalizeTarget(req.params.target);
      if (!target || !TARGETS[target].writable) {
        res.status(400).json({ success: false, error: 'This target does not support configuration restore.' });
        return;
      }
      const snapshots = await readDefaultSnapshot(target);
      if (!snapshots) {
        res.status(404).json({ success: false, error: '尚未保存本机原配置。首次启用自定义接口时会自动保存。' });
        return;
      }

      const current = await captureFiles(targetConfigPaths(target));
      try {
        const store = await readStore();
        // Restoring the native config is also "switching away" — keep the
        // user's live hand edits on the outgoing provider record first.
        await adoptLiveProviderEdits(store, target);
        for (const filePath of targetConfigPaths(target)) await backupFile(filePath);
        await restoreFiles(snapshots);
        delete store.activeByTarget[target];
        await writeStore(store);
        clearAutoFailoverRecord(target);
        res.json({
          success: true,
          target,
          restoredFiles: snapshots.map((snapshot) => displayConfigPath(snapshot.filePath)),
          activeByTarget: store.activeByTarget,
        });
      } catch (error) {
        await restoreFiles(current);
        throw error;
      }
    });
  } catch (error) {
    next(error);
  }
});

// Run one health poll immediately (the scheduler keeps its own cadence).
router.post('/switch/health/check-now', async (_req, res, next) => {
  try {
    const snapshot = await runHealthTick();
    res.json({ success: true, health: snapshot });
  } catch (error) {
    next(error);
  }
});

// Persist health-monitor preferences (enabled / interval / per-target auto failover).
router.post('/switch/health/settings', async (req, res, next) => {
  try {
    await withSwitchMutation(async () => {
      const store = await readStore();
      // Type-gated patch: a field of the wrong type is IGNORED (stored value
      // kept) rather than silently normalized back to defaults — otherwise
      // POST {"intervalMinutes":"abc"} would reset a stored 30 to 5.
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      if (typeof body.intervalMinutes === 'number' && Number.isFinite(body.intervalMinutes)) {
        patch.intervalMinutes = body.intervalMinutes;
      }
      if (Array.isArray(body.autoFailoverTargets)) patch.autoFailoverTargets = body.autoFailoverTargets;
      store.healthMonitor = normalizeHealthMonitorSettings({ ...store.healthMonitor, ...patch });
      await writeStore(store);
      res.json({ success: true, health: getHealthSnapshot(store.healthMonitor) });
    });
  } catch (error) {
    next(error);
  }
});

// User-initiated failover: live-probe siblings of the target's active provider
// and switch to the first one that answers. 409 when nothing passes.
router.post('/switch/health/failover-now', async (req, res, next) => {
  try {
    const target = normalizeTarget(req.body?.target);
    if (!target || !TARGETS[target].writable) {
      res.status(400).json({ success: false, error: '不支持的智能体目标。' });
      return;
    }
    const failover = await runManualFailover(target);
    if (!failover) {
      res.status(409).json({ success: false, error: '没有探测通过的备用节点，未切换。' });
      return;
    }
    res.json({ success: true, failover, health: getHealthSnapshot((await readStore()).healthMonitor) });
  } catch (error) {
    next(error);
  }
});

router.post('/switch/import-current', async (_req, res, next) => {
  try {
    await withSwitchMutation(async () => {
      const store = await readStore();
      const imported = await importCurrentProviders(store);
      await writeStore(store);
      res.json({
        success: true,
        imported: imported.map(sanitizeProvider),
        providers: store.providers.map(sanitizeProvider),
        activeByTarget: store.activeByTarget,
      });
    });
  } catch (error) {
    next(error);
  }
});

router.post('/switch/import-cc-switch', async (_req, res, next) => {
  try {
    await withSwitchMutation(async () => {
      const store = await readStore();
      const result = await importCcSwitchProviders(store);
      if (!result.dbFound) {
        res.status(404).json({ success: false, error: '未找到旧切换器数据库（~/.cc-switch/cc-switch.db）。' });
        return;
      }
      await writeStore(store);
      res.json({
        success: true,
        imported: result.imported.map(sanitizeProvider),
        skipped: result.skipped,
        providers: store.providers.map(sanitizeProvider),
        activeByTarget: store.activeByTarget,
      });
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/switch/providers/:id', async (req, res, next) => {
  try {
    await withSwitchMutation(async () => {
      const store = await readStore();
      const index = store.providers.findIndex((item) => item.id === req.params.id);
      if (index === -1) {
        res.status(404).json({ success: false, error: 'Provider not found.' });
        return;
      }
      const [removed] = store.providers.splice(index, 1);
      for (const [target, activeId] of Object.entries(store.activeByTarget)) {
        if (activeId === removed.id) delete store.activeByTarget[target];
      }
      // Prune any routing slot bound to the deleted provider so it can't dangle.
      for (const slots of Object.values(store.routingSlots ?? {})) {
        for (const [slotId, binding] of Object.entries(slots)) {
          if (binding.providerId === removed.id) delete slots[slotId];
        }
      }
      await writeStore(store);
      res.json({
        success: true,
        removed: sanitizeProvider(removed),
        providers: store.providers.map(sanitizeProvider),
        activeByTarget: store.activeByTarget,
      });
    });
  } catch (error) {
    next(error);
  }
});

router.post('/switch/providers/:id/test', async (req, res, next) => {
  try {
    const store = await readStore();
    const provider = store.providers.find((item) => item.id === req.params.id);
    if (!provider) {
      res.status(404).json({ success: false, error: 'Provider not found.' });
      return;
    }
    const result = await testProviderConnectivity(provider);
    res.json({ success: true, provider: provider.id, ...result });
  } catch (error) {
    next(error);
  }
});

router.post('/switch/discover-models', async (req, res, next) => {
  try {
    let apiKey = req.body?.apiKey;
    if (!apiKey && req.body?.useStoredKey === true && req.body?.providerId) {
      const store = await readStore();
      const storedProvider = store.providers.find((item) => item.id === req.body.providerId);
      if (!storedProvider) {
        res.status(404).json({ success: false, error: 'Provider not found.' });
        return;
      }
      const draftDestination = normalizeProvider({
        ...storedProvider,
        target: req.body?.target,
        baseUrl: req.body?.baseUrl,
        wireApi: req.body?.wireApi,
        apiKey: storedProvider.apiKey,
      }, storedProvider);
      if (providerCredentialDestinationFingerprint(draftDestination) !== providerCredentialDestinationFingerprint(storedProvider)) {
        res.status(400).json({ success: false, error: '修改请求地址或协议后必须重新输入 API Key。' });
        return;
      }
      apiKey = storedProvider.apiKey || '';
    }
    const provider = normalizeProvider({
      id: 'draft-model-discovery',
      name: 'Draft',
      target: req.body?.target,
      baseUrl: req.body?.baseUrl,
      apiKey,
      wireApi: req.body?.wireApi,
    });
    const result = await discoverProviderModels(provider, {
      baseUrl: req.body?.baseUrl,
      timeoutMs: req.body?.timeoutMs,
      bypassCache: req.body?.bypassCache === true,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post('/switch/providers/:id/models', async (req, res, next) => {
  try {
    const store = await readStore();
    const provider = store.providers.find((item) => item.id === req.params.id);
    if (!provider) {
      res.status(404).json({ success: false, error: 'Provider not found.' });
      return;
    }
    const result = await discoverProviderModels(provider, {
      timeoutMs: req.body?.timeoutMs,
      bypassCache: true,
    });
    await withSwitchMutation(async () => {
      const latestStore = await readStore();
      const latestProvider = latestStore.providers.find((item) => item.id === req.params.id);
      if (!latestProvider) return;
      latestProvider.discoveredModels = result.models;
      latestProvider.modelDiscovery = {
        endpoint: result.endpoint,
        updatedAt: result.cache.updatedAt,
        expiresAt: result.cache.expiresAt,
        latencyMs: result.latencyMs,
        httpStatus: result.httpStatus,
        modelCount: result.models.length,
        lastSuccessAt: nowIso(),
        lastErrorAt: null,
      };
      latestProvider.modelDiscoveryError = '';
      latestProvider.updatedAt = nowIso();
      await writeStore(latestStore);
    });
    res.json({ success: true, provider: provider.id, ...result });
  } catch (error) {
    next(error);
  }
});

router.post('/switch/providers/:id/benchmark', async (req, res, next) => {
  try {
    const store = await readStore();
    const provider = store.providers.find((item) => item.id === req.params.id);
    if (!provider) {
      res.status(404).json({ success: false, error: 'Provider not found.' });
      return;
    }
    const result = await benchmarkProviderModel(provider, req.body || {});
    res.json({ success: true, provider: provider.id, ...result });
  } catch (error) {
    next(error);
  }
});

router.post('/switch/providers/:id/endpoints/test', async (req, res, next) => {
  try {
    await withSwitchMutation(async () => {
      const store = await readStore();
      const provider = store.providers.find((item) => item.id === req.params.id);
      if (!provider) {
        res.status(404).json({ success: false, error: 'Provider not found.' });
        return;
      }
      const requestedEndpoints: string[] = Array.isArray(req.body?.endpoints)
        ? req.body.endpoints.map((endpoint: unknown) => {
          const value = endpoint && typeof endpoint === 'object' && 'url' in endpoint ? endpoint.url : endpoint;
          return safeText(value, 800).replace(/\/+$/, '');
        }).filter(Boolean)
        : provider.endpoints;
      const persistedEndpoints = new Set(normalizeEndpointUrls(provider, provider, provider.baseUrl));
      const untrustedEndpoint = requestedEndpoints.find((endpoint: string) => !persistedEndpoints.has(endpoint));
      if (untrustedEndpoint) {
        res.status(400).json({ success: false, error: '测试新端点前必须编辑 Provider 并重新输入 API Key。' });
        return;
      }
      if (requestedEndpoints?.length && !requestedEndpoints.includes(provider.baseUrl)) {
        provider.baseUrl = requestedEndpoints[0];
      }
      const endpoints = normalizeEndpointUrls({ endpoints: requestedEndpoints }, provider, provider.baseUrl);
      const results = await testProviderEndpoints(provider, { ...req.body, endpoints });
      const autoSelectEndpoint = typeof req.body?.autoSelectEndpoint === 'boolean'
        ? req.body.autoSelectEndpoint
        : Boolean(provider.autoSelectEndpoint);
      const nextStats = appendEndpointSamples(provider.endpointStats, results);
      const fastest = results
        .filter((result) => result.usable)
        .sort((left, right) => endpointLatencyP95(nextStats[left.url]) - endpointLatencyP95(nextStats[right.url]))[0] || null;
      provider.endpoints = endpoints;
      provider.autoSelectEndpoint = autoSelectEndpoint;
      provider.endpointStats = nextStats;
      if (autoSelectEndpoint && fastest) provider.baseUrl = fastest.url;
      provider.updatedAt = nowIso();
      await writeStore(store);
      res.json({
        success: true,
        provider: sanitizeProvider(provider),
        selectedBaseUrl: provider.baseUrl,
        results,
      });
    });
  } catch (error) {
    next(error);
  }
});

router.get('/switch/backups', async (_req, res, next) => {
  try {
    const root = path.join(switchDir(), 'backups');
    const backups: BackupRecord[] = [];
    async function walk(dir: string): Promise<void> {
      let entries: import('node:fs').Dirent[] = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (toNodeError(error).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        const filePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(filePath);
        } else {
          const relativePath = path.relative(root, filePath);
          const targetPath = resolveBackupDestination(relativePath);
          const targetEntry = targetPath
            ? Object.entries(TARGETS).find(([targetId]) => (
              targetConfigPaths(targetId).some((candidate) => path.resolve(candidate) === path.resolve(targetPath))
            ))
            : null;
          const stats = await fs.stat(filePath);
          backups.push({
            path: filePath,
            relativePath,
            targetPath: targetPath ? displayConfigPath(targetPath) : null,
            targetId: targetEntry?.[0] || null,
            targetLabel: targetEntry?.[1].label || '未知智能体',
            fileName: path.basename(targetPath || filePath),
            createdAt: new Date(stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs).toISOString(),
            size: stats.size,
          });
        }
      }
    }
    await walk(root);
    backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ success: true, backups });
  } catch (error) {
    next(error);
  }
});

router.post('/switch/backups/restore', async (req, res, next) => {
  try {
    await withSwitchMutation(async () => {
      const root = path.resolve(switchDir(), 'backups');
      const relativePath = String(req.body?.relativePath || '').trim();
      const backupPath = path.resolve(root, relativePath);
      if (!relativePath || !backupPath.startsWith(`${root}${path.sep}`)) {
        const error: StatusError = new Error('Invalid backup path.');
        error.statusCode = 400;
        throw error;
      }

      const destination = resolveBackupDestination(relativePath);
      if (!destination) {
        const error: StatusError = new Error('Backup path does not include a restorable config path.');
        error.statusCode = 400;
        throw error;
      }
      if (!allowedConfigDestinations().has(destination)) {
        const error: StatusError = new Error('Backup destination is not a recognized local Agent config path.');
        error.statusCode = 400;
        throw error;
      }

      const contents = await fs.readFile(backupPath);
      await backupFile(destination);
      await atomicWrite(destination, contents, 0o600);
      res.json({ success: true, restoredPath: destination });
    });
  } catch (error) {
    next(error);
  }
});


export default router;
