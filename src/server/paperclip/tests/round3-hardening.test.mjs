// 1.1.6：本轮原生补丁的接线与范围约束（不依赖上游依赖安装；PAPERCLIP_SOURCE 时核对固定源码）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { source, candidate, original, applyPatches, readJson } from './helpers/patched.mjs';

const round3 = readJson('native/round3-hardening.patch.json');
const testAssertions = readJson('native/ui-test-assertions.patch.json');
const applyScript = fs.readFileSync(new URL('../scripts/apply-native-cli-auth.mjs', import.meta.url), 'utf8');

test('round3 hardening patch is registered and UI test assertion patches stay inside ui/src test files', () => {
  assert.match(applyScript, /'round3-hardening\.patch\.json','server-display-copy\.patch\.json','ui-test-assertions\.patch\.json'/);
  for (const patch of testAssertions) assert.match(patch.file, /^ui\/src\/[A-Za-z0-9_./-]+\.test\.tsx?$/);
  assert.ok(round3.every(patch => !/\.test\.tsx?$/.test(patch.file) || patch.file === 'server/src/__tests__/http-log-redaction.test.ts'));
});

test('security headers are installed immediately after express() and x-powered-by is disabled', { skip: !source }, () => {
  const app = applyPatches(original('server/src/app.ts'), round3, 'server/src/app.ts');
  const start = app.indexOf('const app = express();');
  const block = app.slice(start, app.indexOf('app.locals.paperclipDb = db;', start));
  assert.match(block, /app\.disable\("x-powered-by"\);/);
  assert.match(block, /app\.use\(nativeSecurityHeaders\(/);
  assert.ok(app.indexOf('app.use(nativeSecurityHeaders(') < app.indexOf('app.use(httpLogger);'));
  assert.doesNotMatch(app, /Content-Security-Policy/i);
});

test('request logs use a closed projection and keep the existing redaction paths', { skip: !source }, () => {
  const logger = applyPatches(original('server/src/middleware/logger.ts'), round3, 'server/src/middleware/logger.ts');
  assert.match(logger, /return \{\n {10}id: req\.id,\n {10}method: req\.method,/);
  assert.doesNotMatch(logger, /\.\.\.req,/);
  assert.match(logger, /return \{ statusCode: res\.statusCode \};/);
  assert.match(logger, /redact: \[\.\.\.HTTP_LOG_REDACT_PATHS\]/);
  assert.match(logger, /shouldDemoteHttpSuccessLog\(_req\.method, _req\.url, res\.statusCode\)/);
});

test('agent and CLI spawn points strip inherited server secrets', { skip: !source }, () => {
  const expectations = {
    'packages/adapter-utils/src/server-utils.ts': 'const childEnv = stripServerPrivateEnv({ ...mergedEnv, ...target.env }, process.env);',
    'packages/adapter-utils/src/remote-execution-env.ts': 'if (isServerPrivateEnvKey(normalizedKey)',
    'server/src/services/native-runtime/native-codex-runner.ts': '...stripServerPrivateEnv(process.env),',
    'server/src/routes/board-chat.ts': '...stripServerPrivateEnv(process.env),',
    'server/src/services/workspace-runtime.ts': 'stripServerPrivateEnv({ ...process.env })',
    'server/src/services/workspace-runtime.ts#services': 'stripServerPrivateEnv({ ...baseEnv }, baseEnv)',
  };
  for (const [key, needle] of Object.entries(expectations)) { const file = key.split('#')[0]; assert.ok(applyPatches(original(file), round3, file).includes(needle), key); }
});

test('generated candidate contains the round3 overlay and shared private-env module', { skip: !candidate }, () => {
  const read = file => fs.readFileSync(new URL(file, `file://${fs.realpathSync(candidate)}/`), 'utf8');
  assert.equal(read('packages/adapter-utils/src/server-private-env.ts'), fs.readFileSync(new URL('../native/adapter-utils/server-private-env.ts', import.meta.url), 'utf8'));
  assert.match(read('server/src/app.ts'), /app\.disable\("x-powered-by"\)/);
  assert.match(read('ui/src/components/SidebarSection.tsx'), /`\$\{label\} 操作`/);
  assert.match(read('ui/src/components/OnboardingWizard.tsx'), /cursor: "cursor-agent",/);
});
