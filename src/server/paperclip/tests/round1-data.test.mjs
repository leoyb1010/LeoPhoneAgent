import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { source, original as pinned, applyPatches } from './helpers/patched.mjs';
const original = process.env.PAPERCLIP_TEST_ORIGINAL === 'true';
const patches = JSON.parse(fs.readFileSync(new URL('../catalogs/zz-round1-data.structural.json', import.meta.url)));
function text(file) {
  const value = pinned(file);
  return original ? value : applyPatches(value, patches, file, `pinned context ${file}`);
}
function load(file, requires, fetch) {
  const js = ts.transpileModule(text(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
  const exports = {};
  new Function('exports', 'require', 'fetch', 'console', 'window', 'navigator', js)(exports, name => {
    assert.ok(Object.hasOwn(requires, name), `unexpected production import ${name}`); return requires[name];
  }, fetch, { error() {} }, undefined, undefined);
  return exports;
}
function fixture() {
  let account = 'A'; const requests = [];
  const fetch = (url, init) => new Promise((resolve, reject) => requests.push({ url, init, account, resolve: (body, status = 200) => resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })), reject }));
  const recovery = { recoverIfNeeded: () => null };
  const response = { readApiJson: res => res.json() };
  const client = load('ui/src/api/client.ts', { '@/lib/page-visibility': { getPageVisibility: () => ({ visible: true, focused: true }), getVisibilityHeaderValue: () => 'focused' }, '@/lib/tenant-session-recovery': { tenantSessionRecovery: recovery }, './response': response }, fetch);
  const auth = load('ui/src/api/auth.ts', { '@paperclipai/shared': { authSessionSchema: { safeParse: value => ({ success: Boolean(value?.user?.id && (value.session === null || value.session?.id)), data: value }) } }, '@/lib/redact-url-secrets': { redactUrlSecrets: value => value }, '@/lib/tenant-session-recovery': { tenantSessionRecovery: recovery }, './response': response, './client': client }, fetch);
  return { client, auth: auth.authApi, requests, setAccount: value => { account = value; }, gets: () => requests.filter(r => r.init.method === 'GET'), posts: () => requests.filter(r => r.init.method === 'POST') };
}
for (const method of ['signInEmail', 'signUpEmail', 'signOut']) test(`actual ${method} fences GETs before, during and after the cookie mutation`, { skip: !source }, async () => {
  const f = fixture(); const path = '/issues/fixture-shared-id';
  const old = f.client.api.get(path);
  const mutation = f.auth[method]({ email: 'fixture@example.test', password: 'fixture-only', name: 'fixture' });
  const duringA = f.client.api.get(path);
  f.setAccount('B'); // Set-Cookie headers arrived; response body has not settled.
  const duringB = f.client.api.get(path);
  assert.equal(f.gets().length, 3, 'auth uncertainty cannot reuse the previous account or another pending GET');
  f.posts()[0].resolve({ success: true }); await mutation;
  const next = f.client.api.get(path); const coalesced = f.client.api.get(path);
  assert.equal(f.gets().length, 4, 'ordinary same-account requests still coalesce after completion');
  f.gets()[0].resolve({ owner: 'A' }); f.gets()[1].resolve({ owner: 'A' }); f.gets()[2].resolve({ owner: 'B' }); f.gets()[3].resolve({ owner: 'B' });
  assert.deepEqual(await old, { owner: 'A' }); assert.deepEqual(await duringA, { owner: 'A' });
  assert.deepEqual(await duringB, { owner: 'B' }); assert.deepEqual(await next, { owner: 'B' }); assert.deepEqual(await coalesced, { owner: 'B' });
});
test('official null and local-board sessions remain valid but malformed successful JSON is not logout', { skip: !source }, async () => {
  for (const payload of [null, { data: null }, { session: null, user: { id: 'local-board' } }, { session: { id: 'fixture-session' }, user: { id: 'B' } }]) {
    const f = fixture(); const pending = f.auth.getSession(); f.requests[0].resolve(payload);
    assert.deepEqual(await pending, payload?.user ? payload : null);
  }
  for (const payload of [{}, { data: {} }, { error: 'unexpected-success-body' }]) {
    const f = fixture(); const pending = f.auth.getSession(); f.requests[0].resolve(payload);
    await assert.rejects(pending, { code: 'auth_session_response_invalid' });
  }
});
test('actual identity-change cleanup resets old QueryClient data and late HTTP while retaining session and health', { skip: !source }, async () => {
  const { QueryClient, isCancelledError } = await import(pathToFileURL(path.join(source, 'ui/node_modules/@tanstack/react-query/build/modern/index.js')));
  const { queryKeys } = await import(pathToFileURL(path.join(source, 'ui/src/lib/queryKeys.ts')));
  const value = text('ui/src/context/CompanyContext.tsx');
  const ast = ts.createSourceFile('CompanyContext.tsx', value, ts.ScriptTarget.Latest, true);
  let effect, effectName;
  function visit(n) { if (ts.isCallExpression(n) && n.arguments[0] && n.arguments[0].getText(ast).includes('const previousUserId = observedUserIdRef.current')) { effect = n.arguments[0]; effectName = n.expression.getText(ast); } ts.forEachChild(n, visit); }
  visit(ast); assert.ok(effect);
  const f = fixture(); const client = new QueryClient(); const detailKey = ['issue', 'fixture'];
  client.setQueryData(detailKey, { owner: 'A' });
  client.setQueryData(queryKeys.health, { instance: 'preserved' });
  client.setQueryData(queryKeys.auth.session, { user: { id: 'B' } });
  const old = client.fetchQuery({ queryKey: detailKey, queryFn: () => f.client.api.get('/issues/fixture'), staleTime: 0 }).catch(error => error);
  const predicates = execFileSync('git', ['show', 'HEAD:ui/src/hooks/useSignOut.ts'], { cwd: source, encoding: 'utf8' });
  const predicateAst = ts.createSourceFile('useSignOut.ts', predicates, ts.ScriptTarget.Latest, true);
  const predicate = predicateAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'isAccountScopedQueryKey');
  const predicateJs = ts.transpileModule(predicate.getText(predicateAst).replace(/^export\s+/, ''), { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText;
  const isAccountScopedQueryKey = new Function('INSTANCE_SCOPED_QUERY_ROOTS', `${predicateJs};return isAccountScopedQueryKey;`)([queryKeys.health[0]]);
  const deps = { isSessionSettled: true, observedUserIdRef: { current: 'A' }, sessionUserId: 'B', setSelectedCompanyIdState: () => {}, setSelectionSource: () => {}, queryClient: client, beginApiSessionChange: f.client.beginApiSessionChange, isAccountScopedQueryKey, queryKeys };
  const callbackJs = ts.transpileModule(`const effect = ${effect.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText;
  new Function(...Object.keys(deps), `${callbackJs};effect();`)(...Object.values(deps));
  assert.equal(client.getQueryData(detailKey), undefined);
  assert.equal(effectName, 'useLayoutEffect');
  assert.deepEqual(client.getQueryData(queryKeys.auth.session), { user: { id: 'B' } });
  assert.deepEqual(client.getQueryData(queryKeys.health), { instance: 'preserved' });
  assert.equal(isCancelledError(await old), true);
  f.setAccount('B'); const fresh = client.fetchQuery({ queryKey: detailKey, queryFn: () => f.client.api.get('/issues/fixture') });
  assert.equal(f.gets().length, 2);
  f.gets()[1].resolve({ owner: 'B' }); await fresh;
  f.gets()[0].resolve({ owner: 'A' }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(client.getQueryData(detailKey), { owner: 'B' }, 'late A promise cannot re-enter the reset cache');
  new Function(...Object.keys(deps), `${callbackJs};effect();`)(...Object.values(deps));
  assert.deepEqual(client.getQueryData(detailKey), { owner: 'B' }, 'ordinary same-identity refetch does not clear data');
  const unsettled = { ...deps, isSessionSettled: false, sessionUserId: 'A' };
  new Function(...Object.keys(unsettled), `${callbackJs};effect();`)(...Object.values(unsettled));
  assert.deepEqual(client.getQueryData(detailKey), { owner: 'B' }, 'initial/failed identity lookup is not a confirmed identity change');
  assert.deepEqual(client.getQueryData(queryKeys.auth.session), { user: { id: 'B' } });
  client.clear();
});
for (const failure of ['http', 'network']) test(`failed/unknown ${failure} auth never restores old GETs after a server-side cookie change`, { skip: !source }, async () => {
  const f = fixture(); const old = f.client.api.get('/run/fixture');
  const mutation = f.auth.signInEmail({ email: 'fixture@example.test', password: 'fixture-only' });
  f.setAccount('B');
  if (failure === 'http') f.posts()[0].resolve({ error: 'fixture auth response lost' }, 500);
  else f.posts()[0].reject(new TypeError('fixture network failure'));
  await assert.rejects(mutation);
  const next = f.client.api.get('/run/fixture'); const joined = f.client.api.get('/run/fixture');
  assert.equal(f.gets().length, 2);
  f.gets()[0].resolve({ owner: 'A' }); f.gets()[1].resolve({ owner: 'B' });
  assert.deepEqual(await old, { owner: 'A' }); assert.deepEqual(await next, { owner: 'B' }); assert.deepEqual(await joined, { owner: 'B' });
});
test('concurrent auth changes keep isolation until both settle, and retired completion cannot delete a new entry', { skip: !source }, async () => {
  const f = fixture(); const path = '/agents/fixture'; const old = f.client.api.get(path);
  const first = f.auth.signInEmail({ email: 'fixture@example.test', password: 'fixture-only' });
  const second = f.auth.signOut();
  f.posts()[0].resolve({ success: true }); await first;
  const during1 = f.client.api.get(path); const during2 = f.client.api.get(path);
  assert.equal(f.gets().length, 3, 'one unresolved auth still disables sharing');
  f.posts()[1].resolve({ error: 'fixture sign-out failed' }, 500); await assert.rejects(second);
  f.setAccount('B'); const fresh = f.client.api.get(path);
  f.gets()[0].resolve({ owner: 'A' }); await old;
  assert.equal(f.client.__inflightGetCount(), 1, 'retired promise never removes the new entry');
  const joined = f.client.api.get(path); assert.equal(f.gets().length, 4);
  f.gets()[1].resolve({ during: 1 }); f.gets()[2].resolve({ during: 2 }); f.gets()[3].resolve({ owner: 'B' });
  await Promise.all([during1, during2]); assert.deepEqual(await fresh, { owner: 'B' }); assert.deepEqual(await joined, { owner: 'B' });
});
test('without auth changes the actual client keeps shared fetching and independent cancellation', { skip: !source }, async () => {
  const f = fixture(); const abort = new AbortController();
  const first = f.client.api.get('/issues/steady', { signal: abort.signal }); const second = f.client.api.get('/issues/steady');
  assert.equal(f.gets().length, 1); abort.abort(); await assert.rejects(first, { name: 'AbortError' });
  assert.equal(f.gets()[0].init.signal.aborted, false);
  f.gets()[0].resolve({ stable: true }); assert.deepEqual(await second, { stable: true });
});
