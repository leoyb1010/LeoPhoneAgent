import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
const source = process.env.PAPERCLIP_SOURCE;
const candidate = process.env.PAPERCLIP_CANDIDATE;
const patches = JSON.parse(fs.readFileSync(new URL('../catalogs/native-cli-auth.structural.json', import.meta.url)));
const original = file => execFileSync('git', ['show', `HEAD:${file}`], { cwd: source, encoding: 'utf8', maxBuffer: 20e6 });
function patched(file) {
  let text = original(file);
  for (const patch of patches.filter(p => p.file === file)) {
    assert.equal(text.split(patch.from).length - 1, patch.expected, `pinned input anchor ${file}`);
    text = text.split(patch.from).join(patch.to);
  }
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  assert.deepEqual(ast.parseDiagnostics, [], `valid TSX ${file}`);
  return text;
}
function condition(text, name, bindings) {
  const ast = ts.createSourceFile('auth.tsx', text, ts.ScriptTarget.Latest, true);
  const nodes = [];
  function visit(n) { if (ts.isVariableDeclaration(n) && n.name.getText(ast) === name) nodes.push(n); ts.forEachChild(n, visit); }
  visit(ast); assert.equal(nodes.length, 1, name);
  const js = ts.transpileModule(`const result = ${nodes[0].initializer.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return Function(...Object.keys(bindings), `${js};return result;`)(...Object.values(bindings));
}
function check(read) {
  const newAgent = read('ui/src/components/new-agent/NewAgentSetup.tsx');
  const credentialStep = read('ui/src/components/ai-connections/AiConnectionCredentialStep.tsx');
  for (const text of [newAgent, credentialStep]) {
    const bindings = { environment: { driver: 'local' }, loginHealth: { data: {} }, caps: { data: { sandboxProviders: { fixture: { supportsLoginPty: true } } } }, sandboxProvider: 'fixture' };
    assert.equal(condition(text, 'canLogin', bindings), false, 'a public server without an explicit native capability stays closed');
    bindings.loginHealth.data.nativeAdapterLoginSupported = true;
    assert.equal(condition(text, 'canLogin', bindings), true, 'enabled native server offers the browser panel');
    bindings.environment.driver = 'sandbox'; bindings.loginHealth.data.nativeAdapterLoginSupported = false;
    assert.equal(condition(text, 'canLogin', bindings), true, 'sandbox gate still reads its provider capability');
    bindings.caps.data.sandboxProviders.fixture.supportsLoginPty = false;
    assert.equal(condition(text, 'canLogin', bindings), false, 'unsupported sandbox remains closed');
  }
  const provider = read('ui/src/components/new-agent/AgentProviderConnection.tsx');
  const needs = { method: 'subscription', canLogin: true, nativeLoginResult: null, auth: { data: { status: 'present', installed: true } }, environmentId: 'local', savedSubscription: null, savedKeys: { loading: false }, storedLogin: { data: null }, managedAccount: undefined, nativeReauthRequested: false, subscriptionId: null };
  assert.equal(Boolean(condition(provider, 'needsLogin', needs)), false, 'detecting an existing login never starts OAuth');
  needs.nativeReauthRequested = true;
  assert.equal(Boolean(condition(provider, 'needsLogin', needs)), true, 'explicit reauthorization opens the native browser panel');
  needs.nativeLoginResult = { connectionId: 'ready', grantId: 'ready' };
  assert.equal(Boolean(condition(provider, 'needsLogin', needs)), false, 'completed native OAuth waits for explicit adoption');
  needs.nativeLoginResult = null; needs.auth.data.installed = false;
  assert.equal(Boolean(condition(provider, 'needsLogin', needs)), false, 'a missing CLI cannot launch a login');
  assert.ok(provider.includes('auth.refetch()'), 'the user can refresh actual CLI status');
  assert.ok(provider.includes('auth.data.message'), 'server installation diagnostic is rendered');
  assert.ok(provider.includes('aiConnectionsApi.setDefault(companyId, nativeLoginResult.grantId)'), 'the explicit connect action adopts the saved result');
  const panelCallback = provider.slice(provider.indexOf('onConnected={(sessionId) =>'), provider.indexOf(') : savedSubscription ? null'));
  assert.equal(panelCallback.includes('setDefault('), false, 'OAuth completion alone never changes an account default');
  assert.ok(panelCallback.includes('setNativeLoginResult(result)'), 'the pending result stays in memory');
  assert.ok(provider.includes('setNativeLoginResult(null)'), 'cancel clears the pending choice');
  assert.ok(provider.includes('managedIntent ?? {'), 'new native sign-in keeps an isolated account-save intent');
  const onboard = read('ui/src/components/OnboardingWizard.tsx');
  const callback = onboard.slice(onboard.indexOf('onConnected={async (sessionId)'), onboard.indexOf('onStored={() =>', onboard.indexOf('onConnected={async (sessionId)')));
  assert.equal(callback.includes('setDefault('), false, 'onboarding waits for the user to adopt new authorization');
  assert.ok(onboard.includes('connectCredentialStored || nativeLoginResult ||'), 'new auth cannot auto-hire through the saved-account shortcut');
  assert.ok(onboard.includes('canShowAdapterLogin && !nativeLoginResult'), 'new auth is not immediately relaunched');
  const form = read('ui/src/components/AgentConfigForm.tsx');
  assert.ok(form.indexOf("const loginHealth = useQuery") < form.indexOf("const { data: environments = [] } = useQuery"), "native capability is available before resolving the actual login environment");
  assert.ok(form.includes('environmentsEnabled || generalSettings?.executionMode === "kubernetes" || loginHealth.data?.nativeAdapterLoginSupported === true'), "reading the native login environment does not depend on the experimental picker");
  assert.ok(form.includes('showAdapterLogin && !supportsNativeLogin && selectedCompanyId'), 'native panel is not duplicated by parent test feedback');
  assert.ok(form.includes('agentIds: isCreate ? [] : [props.agent.id]'), 'existing-agent sign-in preserves single-agent grant scope');
  assert.ok(form.includes('使用后将改变你的个人默认账号'), 'adoption explains its default-account effect');
  assert.ok(form.includes('setNativeLoginResult(result)'), 'settings do not silently adopt on OAuth completion');
  assert.ok(form.includes('mark("runtime", "runtimeConfig", { ...runtimeConfig, aiConnection: binding })'), 'using a new account creates a reviewable config draft');
  assert.equal(form.split("onClick={() => restartLogin.mutate()}>重新开始授权</Button>").length - 1, 2, "both displayed-code and submitted-code terminal states offer an owned retry");
  assert.ok(form.includes("if (!isTerminal || status === \"authenticated\" || startDisabled || cancelLogin.isPending) return;"), "preparing or successful displayed-code sessions cannot duplicate-start");
  assert.ok(form.includes('grok_local: "Grok"'), 'settings do not show a generic environment label for Grok');
}
test('native CLI browser auth preserves public and sandbox gates and requires explicit adoption', { skip: !source }, () => check(patched));
test('generated native CLI UI has reviewed capability gates, CLI status and adoption controls', { skip: !source || !candidate }, () => check(file => fs.readFileSync(path.join(candidate, file), 'utf8')));
