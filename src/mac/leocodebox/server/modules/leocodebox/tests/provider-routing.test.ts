import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearRoutingSlot,
  resolveSlotForSession,
  setRoutingSlot,
  LONG_CONTEXT_TOKEN_THRESHOLD,
} from '../provider-routing.service.js';
import { getActiveSwitchEnvOverlay } from '../provider-session-env.service.js';

/** Isolated switch store under a temp LEOCODEBOX_TEST_HOME with two claude providers. */
async function withStore(run: () => Promise<void>): Promise<void> {
  const prev = process.env.LEOCODEBOX_TEST_HOME;
  const home = await mkdtemp(path.join(os.tmpdir(), 'routing-store-'));
  process.env.LEOCODEBOX_TEST_HOME = home;
  const switchDir = path.join(home, '.leocodebox', 'switch');
  await mkdir(switchDir, { recursive: true });
  await writeFile(path.join(switchDir, 'providers.json'), JSON.stringify({
    providers: [
      { id: 'claude-fast', target: 'claude', name: 'Fast', baseUrl: 'https://fast.example', apiKey: 'k-fast', model: 'claude-haiku-4', endpoints: [], endpointLabels: {}, autoSelectEndpoint: false, endpointStats: {}, discoveredModels: [], modelDiscovery: null, modelDiscoveryError: '', modelMapping: { sonnet: '', opus: '', haiku: '' }, wireApi: 'responses', notes: '', category: 'custom', createdAt: '', updatedAt: '', source: 'test' },
      { id: 'claude-deep', target: 'claude', name: 'Deep', baseUrl: 'https://deep.example', apiKey: 'k-deep', model: 'claude-opus-4', endpoints: [], endpointLabels: {}, autoSelectEndpoint: false, endpointStats: {}, discoveredModels: [], modelDiscovery: null, modelDiscoveryError: '', modelMapping: { sonnet: '', opus: '', haiku: '' }, wireApi: 'responses', notes: '', category: 'custom', createdAt: '', updatedAt: '', source: 'test' },
    ],
    activeByTarget: { claude: 'claude-fast' },
    healthMonitor: { enabled: true, intervalMinutes: 5, autoFailoverTargets: [] },
    routingSlots: {},
  }));
  try {
    await run();
  } finally {
    if (prev === undefined) delete process.env.LEOCODEBOX_TEST_HOME;
    else process.env.LEOCODEBOX_TEST_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

test('a bound slot overrides the active provider in the env overlay', async () => {
  await withStore(async () => {
    await setRoutingSlot('claude', 'longContext', { providerId: 'claude-deep' });
    // No slot → active (fast) provider.
    const active = await getActiveSwitchEnvOverlay('claude');
    assert.equal(active.ANTHROPIC_BASE_URL, 'https://fast.example');
    // longContext slot → deep provider.
    const routed = await getActiveSwitchEnvOverlay('claude', 'longContext');
    assert.equal(routed.ANTHROPIC_BASE_URL, 'https://deep.example');
    assert.equal(routed.ANTHROPIC_AUTH_TOKEN, 'k-deep');
  });
});

test('a slot model override replaces the provider model', async () => {
  await withStore(async () => {
    await setRoutingSlot('claude', 'background', { providerId: 'claude-fast', model: 'claude-haiku-4-cheap' });
    const routed = await getActiveSwitchEnvOverlay('claude', 'background');
    assert.equal(routed.ANTHROPIC_MODEL, 'claude-haiku-4-cheap');
  });
});

test('resolveSlotForSession returns null when nothing is bound (legacy behavior)', async () => {
  await withStore(async () => {
    const slot = await resolveSlotForSession({ target: 'claude', estimatedTokens: 999_999 });
    assert.equal(slot, null);
  });
});

test('resolveSlotForSession honors explicit > background > longContext > default', async () => {
  await withStore(async () => {
    await setRoutingSlot('claude', 'default', { providerId: 'claude-fast' });
    await setRoutingSlot('claude', 'longContext', { providerId: 'claude-deep' });
    await setRoutingSlot('claude', 'background', { providerId: 'claude-fast' });

    assert.equal(await resolveSlotForSession({ target: 'claude', slot: 'longContext' }), 'longContext');
    assert.equal(await resolveSlotForSession({ target: 'claude', background: true }), 'background');
    assert.equal(await resolveSlotForSession({ target: 'claude', estimatedTokens: LONG_CONTEXT_TOKEN_THRESHOLD }), 'longContext');
    assert.equal(await resolveSlotForSession({ target: 'claude', estimatedTokens: 10 }), 'default');
  });
});

test('a slot bound to a since-deleted provider falls back to the active provider', async () => {
  await withStore(async () => {
    // Bind longContext to deep, then simulate deep being deleted by hand-editing
    // the store's providers list while the slot binding remains (a dangling slot).
    await setRoutingSlot('claude', 'longContext', { providerId: 'claude-deep' });
    const { readStore, writeStore } = await import('../provider-store.service.js');
    const store = await readStore();
    store.providers = store.providers.filter((p) => p.id !== 'claude-deep');
    await writeStore(store);

    // The dangling slot must NOT drop the session to the machine env — it falls
    // back to the active provider (fast), never returns an empty overlay.
    const routed = await getActiveSwitchEnvOverlay('claude', 'longContext');
    assert.equal(routed.ANTHROPIC_BASE_URL, 'https://fast.example');
  });
});

test('setRoutingSlot rejects a provider from a different target; clear removes it', async () => {
  await withStore(async () => {
    await assert.rejects(() => setRoutingSlot('codex', 'default', { providerId: 'claude-fast' }));
    await setRoutingSlot('claude', 'think', { providerId: 'claude-deep' });
    const afterClear = await clearRoutingSlot('claude', 'think');
    assert.equal(afterClear.think, undefined);
  });
});
