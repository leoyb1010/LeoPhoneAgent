// R2 regressions: production SecretStore + stores and exact page methods.
// Native query/HTTP/UI services are deterministic adapters; no native SDK claim.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { randomUUID } from 'node:crypto';
const root = new URL('../app/entry/src/main/ets/', import.meta.url);
function evaluate(source, names, env, filename) {
  const context = vm.createContext({ console, ArrayBuffer, Uint8Array, Date, ...env });
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'strip' }) +
    `\nObject.assign(globalThis,{${names.join(',')}});`, context, { filename });
  return Object.fromEntries(names.map(name => [name, context[name]]));
}
function load(file, names, env = {}) {
  const source = fs.readFileSync(new URL(file, root), 'utf8')
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '').replace(/\bexport\s+/g, '');
  return evaluate(source, names, env, file);
}
function page(file, methods, env) {
  const source = fs.readFileSync(new URL(`pages/${file}.ets`, root), 'utf8');
  const bodies = methods.map(name => {
    const match = new RegExp(`^  private (?:async )?${name}\\(`, 'm').exec(source);
    assert.ok(match, `${file}.${name} exists`);
    const end = source.indexOf('\n  }', match.index) + '\n  }'.length;
    return source.slice(match.index, end);
  });
  return evaluate(`class Page {\n${bodies.join('\n')}\n}`, ['Page'], env, file).Page;
}
const util = {
  generateRandomUUID: () => randomUUID(),
  TextEncoder: class { encodeInto(text) { return new TextEncoder().encode(text); } },
  TextDecoder: { create: () => ({ decodeToString: raw => new TextDecoder().decode(raw) }) }
};
let renameFailure = false;
const fileIo = {
  OpenMode: { READ_ONLY: fs.constants.O_RDONLY, READ_WRITE: fs.constants.O_RDWR, CREATE: fs.constants.O_CREAT,
    TRUNC: fs.constants.O_TRUNC, NOFOLLOW: fs.constants.O_NOFOLLOW, DIR: fs.constants.O_DIRECTORY },
  accessSync: fs.existsSync, readTextSync: p => fs.readFileSync(p, 'utf8'),
  openSync(p, flags) { return { fd: fs.openSync(p, flags), tryLock() {} }; },
  closeSync: f => fs.closeSync(f.fd), writeSync: (fd, data) => fs.writeSync(fd, Buffer.from(data)),
  fsyncSync: fs.fsyncSync, unlinkSync: fs.unlinkSync,
  renameSync(a, b) { if (renameFailure) { renameFailure = false; throw new Error('rename failure'); } fs.renameSync(a, b); }
};
const assets = new Map(), removals = [];
const text = raw => new TextDecoder().decode(raw);
let queryFault = null;
function failQuery(alias, kind) { queryFault = { alias, kind }; }
const asset = {
  Tag: { ALIAS: 'alias', SECRET: 'secret', ACCESSIBILITY: 'accessibility', RETURN_TYPE: 'returnType' },
  Accessibility: { DEVICE_FIRST_UNLOCKED: 1 }, ReturnType: { ALL: 1 }, ErrorCode: { NOT_FOUND: 24000002 },
  async add(map) {
    const alias = text(map.get('alias'));
    if (assets.has(alias)) throw new Error('duplicate');
    assets.set(alias, map.get('secret'));
  },
  async update(query, map) {
    const alias = text(query.get('alias'));
    if (!assets.has(alias)) throw new Error('missing update target');
    assets.set(alias, map.get('secret'));
  },
  async query(query) {
    const alias = text(query.get('alias'));
    assert.equal(query.get('returnType'), asset.ReturnType.ALL);
    if (queryFault?.alias === alias) {
      const { kind } = queryFault; queryFault = null;
      if (kind === 'empty-result') return [];
      if (kind === 'missing-secret') return [new Map()];
      if (kind === 'wrong-secret-type') return [new Map([['secret', 1]])];
      if (kind === 'unknown') throw new Error('transient asset query failure');
      throw Object.assign(new Error(`asset query ${kind}`), { code: kind });
    }
    // Native API contract: an absent alias rejects with NOT_FOUND, never a successful empty list.
    if (!assets.has(alias)) throw Object.assign(new Error('not found'), { code: asset.ErrorCode.NOT_FOUND });
    return [new Map([['secret', assets.get(alias)]])];
  },
  async remove(query) { const alias = text(query.get('alias')); removals.push(alias); assets.delete(alias); }
};
const { SecretStore } = load('store/SecretStore.ets', ['SecretStore'], { asset, util });
const atomic = load('store/AtomicFile.ets', ['AtomicTextFile', 'atomicWriteText', 'AtomicCommitUncertainError'], { fileIo, util });
const bound = load('store/BoundSecret.ets', ['BoundSecret'], { SecretStore, util });
const catalog = load('local/ProviderCatalog.ets', ['kindByKey', 'providerKinds']);
const models = load('local/ProviderModels.ets', ['skipUpstreamModels', 'chatModelsFor', 'codexCatalogIds', 'CODEX_MODELS_URL']);
const common = { fileIo, SecretStore, ...atomic, ...bound, ...catalog, ...models,
  OAUTH_ALIAS: 'leo.harmony.oauth', requireProviderRoot: value => value, AppStorage: { setOrCreate() {} } };
const { ProviderStore, ProviderInstance } = load('store/ProviderStore.ets', ['ProviderStore', 'ProviderInstance'], common);
const { McpStore } = load('store/McpStore.ets', ['McpStore'], common); McpStore.listTools = async () => '';
const { EnvStore } = load('store/EnvStore.ets', ['EnvStore'], common);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-r2-'));
const ctx = label => ({ filesDir: fs.mkdtempSync(path.join(temp, label)) });
function providerRow(id = 'p', credential = 'apiKey', type = 'custom') {
  const row = new ProviderInstance();
  Object.assign(row, { id, type, baseUrl: 'https://a.example', model: 'builtin', models: ['builtin'], credential });
  return row;
}
const stores = {
  provider: { make: () => new ProviderStore(), file: 'providers.json', alias: 'leo.harmony.provider_key.p',
    metadata: () => ({ activeId: 'p', instances: [providerRow()], groups: [] }),
    value: s => s.keyFor('p'), row: s => s.instances[0] },
  mcp: { make: () => new McpStore(), file: 'mcp.json', alias: 'leo.harmony.mcp.service',
    metadata: () => ({ rows: [{ label: 'service', url: 'https://a.example' }] }),
    value: s => s.rows[0].secret, row: s => s.rows[0] },
  env: { make: () => new EnvStore(), file: 'env.json', alias: 'leo.harmony.env.ENV',
    metadata: () => ({ rows: [{ name: 'ENV' }] }), value: s => s.rows[0].value, row: s => s.rows[0] }
};
const faults = ['unknown', 24000001, 24000004, 24000005, 24000007, 24000008, 24000010,
  'empty-result', 'missing-secret', 'wrong-secret-type'];
let migrationChecks = 0;
try {
  for (const [kind, factory] of Object.entries(stores)) {
    for (const fault of faults) {
      const c = ctx(kind), target = path.join(c.filesDir, factory.file);
      fs.writeFileSync(target, JSON.stringify(factory.metadata()));
      await SecretStore.write(factory.alias, 'DUMMY_LEGACY_KEY');
      const before = fs.readFileSync(target, 'utf8'), retired = removals.length;
      failQuery(factory.alias, fault);
      const store = factory.make();
      await assert.rejects(store.load(c));
      assert.equal(fs.readFileSync(target, 'utf8'), before);
      assert.equal(text(assets.get(factory.alias)), 'DUMMY_LEGACY_KEY');
      assert.equal(removals.length, retired, 'failed read cannot retire any original alias');
      await store.load(c); // Same instance must retry; no false loaded/empty cache.
      assert.equal(factory.value(store), 'DUMMY_LEGACY_KEY');
      assert.ok(factory.row(store).secretRef);
      const fresh = factory.make(); await fresh.load(c);
      assert.equal(factory.value(fresh), 'DUMMY_LEGACY_KEY');
      assert.ok(!assets.has(factory.alias), 'successful retry retires the migrated legacy alias');
      migrationChecks++;
    }
    for (const present of [false, true]) {
      const c = ctx(kind + '-empty'), target = path.join(c.filesDir, factory.file);
      fs.writeFileSync(target, JSON.stringify(factory.metadata()));
      assets.delete(factory.alias);
      if (present) await SecretStore.write(factory.alias, '');
      const store = factory.make(); await store.load(c);
      assert.equal(factory.value(store), ''); assert.ok(factory.row(store).secretRef);
      const fresh = factory.make(); await fresh.load(c); assert.equal(factory.value(fresh), '');
    }
  }
  // Legacy single-provider global alias follows the same uncertainty/retry boundary.
  const globalCtx = ctx('global'), globalAlias = 'leo.harmony.provider_key';
  fs.writeFileSync(path.join(globalCtx.filesDir, 'provider.json'), JSON.stringify({ baseUrl: 'https://old.example', model: 'model' }));
  await SecretStore.write(globalAlias, 'DUMMY_GLOBAL'); failQuery(globalAlias, 24000010);
  const legacy = new ProviderStore(); await assert.rejects(legacy.load(globalCtx));
  assert.ok(assets.has(globalAlias)); assert.ok(!fs.existsSync(path.join(globalCtx.filesDir, 'providers.json')));
  await legacy.load(globalCtx); assert.equal(legacy.keyFor('legacy'), 'DUMMY_GLOBAL');

  // Established generation query failures still reject without touching its selected metadata/bytes.
  const cc = ctx('generation'), established = new ProviderStore(); await established.load(cc);
  await established.upsert(cc, providerRow(), 'DUMMY_GOOD_KEY');
  const reference = established.credentialReference('p'), before = fs.readFileSync(path.join(cc.filesDir, 'providers.json'), 'utf8');
  const reader = new ProviderStore(); failQuery(reference, 'unknown'); await assert.rejects(reader.load(cc));
  assert.equal(fs.readFileSync(path.join(cc.filesDir, 'providers.json'), 'utf8'), before); assert.ok(assets.has(reference));
  await reader.load(cc); assert.equal(reader.keyFor('p'), 'DUMMY_GOOD_KEY');

  // Ordinary save and another provider's edit copy OAuth state. A failed copy must retain all original aliases.
  for (const editOther of [false, true]) {
    const c = ctx('oauth'), store = new ProviderStore(); await store.load(c);
    await store.upsert(c, providerRow('oauth', 'oauth', 'openAI'), 'DUMMY_ACCESS');
    const old = store.credentialReference('oauth'), alias = 'leo.harmony.oauth.' + old;
    const oauth = JSON.stringify({ refresh: 'DUMMY_REFRESH', account: 'acct', type: 'openAI', expire: 1 });
    await SecretStore.write(alias, oauth);
    const metadata = fs.readFileSync(path.join(c.filesDir, 'providers.json'), 'utf8'), retired = removals.length;
    const save = () => editOther ? store.upsert(c, providerRow('other'), 'DUMMY_OTHER') : store.save(c);
    failQuery(alias, 24000005); await assert.rejects(save());
    assert.equal(fs.readFileSync(path.join(c.filesDir, 'providers.json'), 'utf8'), metadata);
    assert.equal(store.credentialReference('oauth'), old); assert.equal(store.keyFor('oauth'), 'DUMMY_ACCESS');
    assert.equal(await SecretStore.read(alias), oauth); assert.equal(removals.length, retired);
    await save(); const next = store.credentialReference('oauth');
    assert.notEqual(next, old); assert.equal(await SecretStore.read('leo.harmony.oauth.' + next), oauth);
    assert.ok(!assets.has(alias)); const fresh = new ProviderStore(); await fresh.load(c);
    assert.equal(fresh.keyFor('oauth'), 'DUMMY_ACCESS');
    const { OAuthSession } = load('local/OAuthSession.ets', ['OAuthSession'], {
      SecretStore, providerStore: fresh, OAUTH_ALIAS: 'leo.harmony.oauth', BrowserOAuth: { canRefresh: () => false }
    });
    failQuery('leo.harmony.oauth.' + next, 24000008);
    await assert.rejects(OAuthSession.ensure('oauth', fresh.keyFor('oauth')));
    const token = await OAuthSession.ensure('oauth', fresh.keyFor('oauth'));
    assert.equal(token.access, 'DUMMY_ACCESS'); assert.equal(token.account, 'acct');
  }
  // A deliberately absent refresh token is valid; a metadata save still works.
  const noRefreshCtx = ctx('no-refresh'), noRefresh = new ProviderStore(); await noRefresh.load(noRefreshCtx);
  await noRefresh.upsert(noRefreshCtx, providerRow('oauth', 'oauth', 'openAI'), 'ACCESS_ONLY');
  await noRefresh.save(noRefreshCtx); assert.equal(noRefresh.keyFor('oauth'), 'ACCESS_ONLY');

  // Execute the exact AddProviderPage.save body, with actual provider catalog + persistence.
  for (const type of ['custom', 'openAI']) {
    const c = ctx('add-' + type), store = new ProviderStore(); await store.load(c);
    store.pullUpstream = async () => ['upstream-model'];
    let navigated = false;
    const Page = page('AddProviderPage', ['save'], { ...catalog, ProviderInstance, providerStore: store,
      getContext: () => c, inputMethod: { getController: () => ({ stopInputSession() {} }) },
      OAuthSession: { bind: async () => {} }, ProviderLaunch: {}, router: { replaceUrl: async () => { navigated = true; } } });
    const view = new Page(); Object.assign(view, { type, credential: 'apiKey', label: '', root: 'https://a.example',
      seedModels: [], appendV1: true, azureMode: false, keyDraft: 'DUMMY_KEY', message: '' });
    await view.save(); assert.equal(navigated, true, view.message);
    const fresh = new ProviderStore(); await fresh.load(c);
    assert.deepEqual(Array.from(fresh.instances[0].models), ['upstream-model']);
    assert.equal(fresh.instances[0].model, 'upstream-model'); assert.equal(fresh.keyFor(fresh.instances[0].id), 'DUMMY_KEY');
  }

  // Exact detail page flow: catalog network fetch refreshes OAuth while its earlier row has become detached.
  const dc = ctx('detail'), detailStore = new ProviderStore(); await detailStore.load(dc);
  await detailStore.upsert(dc, providerRow('oauth', 'oauth', 'openAI'), 'ACCESS_OLD');
  const oldRef = detailStore.credentialReference('oauth');
  await SecretStore.write('leo.harmony.oauth.' + oldRef, JSON.stringify({ refresh: 'REFRESH_OLD', account: 'new-account', type: 'openAI', expire: 1 }));
  const requests = [];
  const oauthHttp = { RequestMethod: { GET: 'GET', POST: 'POST' }, createHttp: () => ({
    async request(url, options) {
      requests.push([url, options]);
      if (url === 'https://oauth.example/token') {
        assert.ok(options.extraData.includes('REFRESH_OLD'));
        return { responseCode: 200, result: JSON.stringify({ access_token: 'ACCESS_NEW', refresh_token: 'REFRESH_NEW', expires_in: 3600 }) };
      }
      assert.ok(url.startsWith(models.CODEX_MODELS_URL));
      assert.equal(options.header.Authorization, 'Bearer ACCESS_NEW');
      assert.equal(options.header['Chatgpt-Account-Id'], 'new-account');
      assert.notEqual(detailStore.credentialReference('oauth'), oldRef, 'refresh committed before model request');
      return { responseCode: 200, result: JSON.stringify({ models: [{ slug: 'codex-new-model' }] }) };
    }, destroy() {}
  }) };
  const { OAuthSession: detailOAuth, OAuthToken } = load('local/OAuthSession.ets', ['OAuthSession', 'OAuthToken'], {
    SecretStore, providerStore: detailStore, OAUTH_ALIAS: 'leo.harmony.oauth', http: oauthHttp,
    accountIdFromIdToken: () => '', BrowserOAuth: { canRefresh: () => true,
      refreshUrl: () => 'https://oauth.example/token', refreshClientId: () => 'fixture', refreshUsesForm: () => true }
  });
  const { OpenAICompatClient } = load('local/OpenAICompatClient.ets', ['OpenAICompatClient'], {
    ...models, ...catalog, util, providerStore: detailStore, http: oauthHttp,
    OAuthSession: detailOAuth, OAuthToken, CODEX_CLIENT_VERSION: 'fixture'
  });
  const Page = page('ProviderDetailPage', ['current', 'pullModels'], { ...models, ProviderInstance,
    providerStore: detailStore, getContext: () => dc, OpenAICompatClient });
  const view = new Page(); Object.assign(view, { rowId: 'oauth', keyDraft: '', label: '', type: 'openAI',
    credential: 'oauth', root: '', customModel: '', model: 'builtin', models: ['builtin'], isOn: true, appendV1: true, azureMode: false });
  await view.pullModels(); assert.deepEqual(Array.from(view.models), ['codex-new-model'], view.message);
  const final = new ProviderStore(); await final.load(dc);
  assert.equal(final.keyFor('oauth'), 'ACCESS_NEW'); assert.equal(final.instances[0].model, 'codex-new-model');
  const refreshedOAuth = JSON.parse(await SecretStore.read('leo.harmony.oauth.' + final.credentialReference('oauth')));
  assert.equal(refreshedOAuth.refresh, 'REFRESH_NEW'); assert.equal(refreshedOAuth.account, 'new-account');
  assert.equal(requests.length, 2, 'actual OAuth token request followed by actual catalog client');

  // Same binding metadata changes survive; a different endpoint or removal rejects the stale catalog.
  for (const mutation of ['label', 'endpoint', 'remove']) {
    const c = ctx('catalog-' + mutation), store = new ProviderStore(); await store.load(c);
    await store.upsert(c, providerRow(), 'DUMMY_KEY');
    const fetch = async () => {
      if (mutation === 'remove') await store.remove(c, 'p');
      else {
        const row = providerRow(); row.label = 'new-label';
        if (mutation === 'endpoint') row.baseUrl = 'https://changed.example';
        await store.upsert(c, row, mutation === 'endpoint' ? 'NEW_KEY' : '');
      }
      return ['catalog-model'];
    };
    if (mutation === 'label') {
      const updated = await store.refreshModels(c, 'p', fetch);
      assert.equal(updated.label, 'new-label'); assert.equal(updated.model, 'catalog-model');
      assert.equal(updated.secretRef, store.credentialReference('p'));
    } else await assert.rejects(store.refreshModels(c, 'p', fetch), /已变化/);
    const fresh = new ProviderStore(); await fresh.load(c);
    if (mutation === 'endpoint') { assert.equal(fresh.instances[0].baseUrl, 'https://changed.example'); assert.equal(fresh.keyFor('p'), 'NEW_KEY'); assert.equal(fresh.instances[0].model, 'builtin'); }
    if (mutation === 'remove') assert.equal(fresh.instances.length, 0);
  }
  // Failed catalog metadata commit preserves the last catalog, and the same call can be retried.
  const fc = ctx('model-save'), store = new ProviderStore(); await store.load(fc);
  await store.upsert(fc, providerRow(), 'KEY'); store.pullUpstream = async () => ['retry-model'];
  renameFailure = true; await assert.rejects(store.refreshModels(fc, 'p'), /rename failure/);
  assert.equal(store.instances[0].model, 'builtin');
  await store.refreshModels(fc, 'p'); const fresh = new ProviderStore(); await fresh.load(fc);
  assert.equal(fresh.instances[0].model, 'retry-model');
  console.log(`HARMONY_SECRET_QUERY_MODELS_OK ${migrationChecks} native-query migration faults + retries + empty controls + OAuth copies + actual add/detail callers`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
