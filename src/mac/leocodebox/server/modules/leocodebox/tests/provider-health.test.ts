import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEGRADE_THRESHOLD,
  getHealthSnapshot,
  resetHealthStateForTests,
  runHealthTick,
  runManualFailover,
} from '../provider-health.service.js';
import type { ProviderHealthProbe } from '../provider-discovery.service.js';
import { adoptLiveProviderEdits } from '../provider-import.service.js';
import {
  normalizeHealthMonitorSettings,
  readStore,
  writeStore,
} from '../provider-store.service.js';
import type { ProviderStore, SwitchProvider } from '../provider-store.service.js';

const okProbe = async (): Promise<ProviderHealthProbe> => ({ ok: true, latencyMs: 42, httpStatus: 200, note: '探测通过。' });
const failProbe = async (): Promise<ProviderHealthProbe> => ({ ok: false, latencyMs: 8000, httpStatus: null, note: '连接超时（8 秒）。' });

function makeProvider(overrides: Partial<SwitchProvider> & { id: string; target: string }): SwitchProvider {
  return {
    name: overrides.id,
    baseUrl: 'https://api.example.com/v1',
    endpoints: ['https://api.example.com/v1'],
    endpointLabels: {},
    autoSelectEndpoint: false,
    endpointStats: {},
    apiKey: 'sk-test',
    model: 'test-model',
    discoveredModels: [],
    modelDiscovery: null,
    modelDiscoveryError: '',
    modelMapping: { sonnet: 'test-model', opus: 'test-model', haiku: 'test-model' },
    wireApi: 'chat',
    notes: '',
    category: 'custom',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'leocodebox-switch',
    ...overrides,
  };
}

async function withIsolatedHome(run: (home: string) => Promise<void>): Promise<void> {
  const previousHome = process.env.LEOCODEBOX_TEST_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'leoapi-health-test-'));
  process.env.LEOCODEBOX_TEST_HOME = home;
  resetHealthStateForTests();
  try {
    await run(home);
  } finally {
    resetHealthStateForTests();
    if (previousHome === undefined) delete process.env.LEOCODEBOX_TEST_HOME;
    else process.env.LEOCODEBOX_TEST_HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function seedStore(mutate: (store: ProviderStore) => void): Promise<void> {
  const store = await readStore();
  mutate(store);
  await writeStore(store);
}

test('runHealthTick keeps a target ok on success and resets failures', async () => {
  await withIsolatedHome(async () => {
    await seedStore((store) => {
      store.providers.push(makeProvider({ id: 'p1', target: 'claude' }));
      store.activeByTarget.claude = 'p1';
    });
    const snapshot = await runHealthTick(okProbe);
    assert.equal(snapshot.targets.claude?.status, 'ok');
    assert.equal(snapshot.targets.claude?.consecutiveFailures, 0);
    assert.equal(snapshot.targets.claude?.lastLatencyMs, 42);
  });
});

test(`a target degrades only after ${DEGRADE_THRESHOLD} consecutive failures`, async () => {
  await withIsolatedHome(async () => {
    await seedStore((store) => {
      store.providers.push(makeProvider({ id: 'p1', target: 'claude' }));
      store.activeByTarget.claude = 'p1';
    });
    let snapshot = await runHealthTick(failProbe);
    // First failure: grace — no premature degraded flag.
    assert.notEqual(snapshot.targets.claude?.status, 'degraded');
    snapshot = await runHealthTick(failProbe);
    assert.equal(snapshot.targets.claude?.status, 'degraded');
    assert.equal(snapshot.targets.claude?.consecutiveFailures, 2);

    // Recovery resets both status and counter.
    snapshot = await runHealthTick(okProbe);
    assert.equal(snapshot.targets.claude?.status, 'ok');
    assert.equal(snapshot.targets.claude?.consecutiveFailures, 0);
  });
});

test('degraded target does NOT auto-switch when the target is not opted in', async () => {
  await withIsolatedHome(async () => {
    await seedStore((store) => {
      store.providers.push(makeProvider({ id: 'p1', target: 'claude' }));
      store.providers.push(makeProvider({ id: 'p2', target: 'claude', baseUrl: 'https://backup.example.com/v1' }));
      store.activeByTarget.claude = 'p1';
      store.healthMonitor.autoFailoverTargets = [];
    });
    await runHealthTick(failProbe);
    await runHealthTick(failProbe);
    const store = await readStore();
    assert.equal(store.activeByTarget.claude, 'p1');
    assert.equal(getHealthSnapshot().targets.claude?.status, 'degraded');
  });
});

test('opted-in target auto-switches to a healthy sibling and records the breadcrumb', async () => {
  await withIsolatedHome(async () => {
    await seedStore((store) => {
      store.providers.push(makeProvider({ id: 'p1', target: 'claude' }));
      store.providers.push(makeProvider({ id: 'p2', target: 'claude', baseUrl: 'https://backup.example.com/v1' }));
      store.activeByTarget.claude = 'p1';
      store.healthMonitor.autoFailoverTargets = ['claude'];
    });
    // Active provider fails; the candidate probe succeeds.
    const probe = async (provider: SwitchProvider): Promise<ProviderHealthProbe> => (
      provider.id === 'p1' ? failProbe() : okProbe()
    );
    await runHealthTick(probe);
    await runHealthTick(probe);

    const store = await readStore();
    assert.equal(store.activeByTarget.claude, 'p2');
    const entry = getHealthSnapshot().targets.claude;
    assert.equal(entry?.providerId, 'p2');
    assert.equal(entry?.status, 'ok');
    assert.equal(entry?.lastAutoFailover?.fromId, 'p1');
    assert.equal(entry?.lastAutoFailover?.toId, 'p2');
    // The switch really wrote the claude settings file (transactional apply ran).
    const settingsRaw = await fs.readFile(path.join(process.env.LEOCODEBOX_TEST_HOME!, '.claude', 'settings.json'), 'utf8');
    assert.match(settingsRaw, /backup\.example\.com/);
  });
});

test('auto-failover stays put when no sibling passes the probe', async () => {
  await withIsolatedHome(async () => {
    await seedStore((store) => {
      store.providers.push(makeProvider({ id: 'p1', target: 'claude' }));
      store.providers.push(makeProvider({ id: 'p2', target: 'claude', baseUrl: 'https://backup.example.com/v1' }));
      store.activeByTarget.claude = 'p1';
      store.healthMonitor.autoFailoverTargets = ['claude'];
    });
    await runHealthTick(failProbe);
    await runHealthTick(failProbe);
    const store = await readStore();
    assert.equal(store.activeByTarget.claude, 'p1');
    assert.equal(getHealthSnapshot().targets.claude?.status, 'degraded');
  });
});

test('auto-failover folds live hand edits into the outgoing provider before switching', async () => {
  await withIsolatedHome(async (home) => {
    await seedStore((store) => {
      store.providers.push(makeProvider({ id: 'p1', target: 'claude', apiKey: 'sk-stale', model: 'old-model' }));
      store.providers.push(makeProvider({ id: 'p2', target: 'claude', baseUrl: 'https://backup.example.com/v1' }));
      store.activeByTarget.claude = 'p1';
      store.healthMonitor.autoFailoverTargets = ['claude'];
    });
    // User hand-rotated the key in the live config (same baseUrl → adoptable).
    await fs.mkdir(path.join(home, '.claude'), { recursive: true });
    await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.example.com/v1',
        ANTHROPIC_AUTH_TOKEN: 'sk-hand-rotated',
        ANTHROPIC_MODEL: 'hand-model',
      },
    }));
    const probe = async (provider: SwitchProvider): Promise<ProviderHealthProbe> => (
      provider.id === 'p1' ? failProbe() : okProbe()
    );
    await runHealthTick(probe);
    await runHealthTick(probe);

    const store = await readStore();
    assert.equal(store.activeByTarget.claude, 'p2');
    // The undo path (re-apply p1) must restore what the user actually ran.
    const outgoing = store.providers.find((item) => item.id === 'p1');
    assert.equal(outgoing?.apiKey, 'sk-hand-rotated');
    assert.equal(outgoing?.model, 'hand-model');
  });
});

test('automatic failover is cooldown-limited; manual failover bypasses it', async () => {
  await withIsolatedHome(async () => {
    await seedStore((store) => {
      store.providers.push(makeProvider({ id: 'p1', target: 'claude' }));
      store.providers.push(makeProvider({ id: 'p2', target: 'claude', baseUrl: 'https://b.example.com/v1' }));
      store.providers.push(makeProvider({ id: 'p3', target: 'claude', baseUrl: 'https://c.example.com/v1' }));
      store.activeByTarget.claude = 'p1';
      store.healthMonitor.autoFailoverTargets = ['claude'];
    });
    // Round 1: p1 fails, p2 answers as candidate → auto-switch p1→p2.
    let probe = async (provider: SwitchProvider): Promise<ProviderHealthProbe> => (
      provider.id === 'p1' ? failProbe() : okProbe()
    );
    await runHealthTick(probe);
    await runHealthTick(probe);
    assert.equal((await readStore()).activeByTarget.claude, 'p2');

    // Round 2: p2 fails as active and p1 is also down (half-broken pair);
    // p3 is the only healthy sibling — but the cooldown suppresses a second
    // AUTOMATIC switch (no ping-pong between half-broken nodes).
    probe = async (provider: SwitchProvider): Promise<ProviderHealthProbe> => (
      provider.id === 'p3' ? okProbe() : failProbe()
    );
    await runHealthTick(probe);
    await runHealthTick(probe);
    assert.equal((await readStore()).activeByTarget.claude, 'p2');
    assert.equal(getHealthSnapshot().targets.claude?.status, 'degraded');

    // The user's explicit click is consent: manual failover bypasses cooldown.
    const failover = await runManualFailover('claude', probe);
    assert.equal(failover?.toId, 'p3');
    assert.equal((await readStore()).activeByTarget.claude, 'p3');
  });
});

test('a throwing probe counts as a failed sample and never kills the tick', async () => {
  await withIsolatedHome(async () => {
    await seedStore((store) => {
      store.providers.push(makeProvider({ id: 'bad', target: 'claude' }));
      store.providers.push(makeProvider({ id: 'good', target: 'codex' }));
      store.activeByTarget.claude = 'bad';
      store.activeByTarget.codex = 'good';
    });
    const probe = async (provider: SwitchProvider): Promise<ProviderHealthProbe> => {
      if (provider.id === 'bad') throw new Error('Invalid provider base URL');
      return okProbe();
    };
    const snapshot = await runHealthTick(probe);
    // The bad target got a failure sample with the thrown message…
    assert.equal(snapshot.targets.claude?.consecutiveFailures, 1);
    assert.match(snapshot.targets.claude?.lastNote ?? '', /探测异常/);
    // …and the OTHER target was still polled in the same tick.
    assert.equal(snapshot.targets.codex?.status, 'ok');
  });
});

test('adoptLiveProviderEdits refuses codex adoption when the managed base_url was hand-changed', async () => {
  await withIsolatedHome(async (home) => {
    await seedStore((store) => {
      store.providers.push(makeProvider({ id: 'cx', target: 'codex', baseUrl: 'https://endpoint-y.example.com/v1', apiKey: 'sk-y' }));
      store.activeByTarget.codex = 'cx';
    });
    await fs.mkdir(path.join(home, '.codex'), { recursive: true });
    await fs.writeFile(path.join(home, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-key-for-x' }));
    await fs.writeFile(path.join(home, '.codex', 'config.toml'), [
      'model_provider = "leocodebox_cx"',
      'model = "hand-model"',
      '[model_providers.leocodebox_cx]',
      'base_url = "https://endpoint-x.example.com/v1"',
    ].join('\n'));
    const store = await readStore();
    const changed = await adoptLiveProviderEdits(store, 'codex');
    // Live key belongs to endpoint-x; adopting it into the endpoint-y record
    // would ship that key to the wrong host on re-apply.
    assert.equal(changed, false);
    assert.equal(store.providers.find((item) => item.id === 'cx')?.apiKey, 'sk-y');
  });
});

test('normalizeHealthMonitorSettings clamps interval and filters unknown targets', () => {
  const normalized = normalizeHealthMonitorSettings({
    enabled: true,
    intervalMinutes: 999,
    autoFailoverTargets: ['claude', 'not-a-target', 'CODEX'],
  });
  assert.equal(normalized.intervalMinutes, 60);
  assert.deepEqual(normalized.autoFailoverTargets, ['claude', 'codex']);
  const defaults = normalizeHealthMonitorSettings(undefined);
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.intervalMinutes, 5);
});

test('adoptLiveProviderEdits folds live claude hand edits back when baseUrl matches', async () => {
  await withIsolatedHome(async (home) => {
    await seedStore((store) => {
      store.providers.push(makeProvider({ id: 'p1', target: 'claude', model: 'old-model' }));
      store.activeByTarget.claude = 'p1';
    });
    await fs.mkdir(path.join(home, '.claude'), { recursive: true });
    await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.example.com/v1',
        ANTHROPIC_AUTH_TOKEN: 'sk-rotated',
        ANTHROPIC_MODEL: 'hand-edited-model',
      },
    }));
    const store = await readStore();
    const changed = await adoptLiveProviderEdits(store, 'claude');
    assert.equal(changed, true);
    const provider = store.providers.find((item) => item.id === 'p1');
    assert.equal(provider?.apiKey, 'sk-rotated');
    assert.equal(provider?.model, 'hand-edited-model');
  });
});

test('adoptLiveProviderEdits refuses to adopt when live config points elsewhere', async () => {
  await withIsolatedHome(async (home) => {
    await seedStore((store) => {
      store.providers.push(makeProvider({ id: 'p1', target: 'claude', model: 'old-model' }));
      store.activeByTarget.claude = 'p1';
    });
    await fs.mkdir(path.join(home, '.claude'), { recursive: true });
    // Another tool rewrote the config to a different endpoint entirely.
    await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://other-tool.example.com/v1',
        ANTHROPIC_AUTH_TOKEN: 'sk-foreign',
        ANTHROPIC_MODEL: 'foreign-model',
      },
    }));
    const store = await readStore();
    const changed = await adoptLiveProviderEdits(store, 'claude');
    assert.equal(changed, false);
    const provider = store.providers.find((item) => item.id === 'p1');
    assert.equal(provider?.apiKey, 'sk-test');
    assert.equal(provider?.model, 'old-model');
  });
});
