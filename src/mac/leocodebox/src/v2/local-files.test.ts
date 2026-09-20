import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { artifactNameFromPath, clipFilePeek, cwdChipLabel, isClippedFilePeek, isPeekDrawer, isWorkspaceDrawer, machineChipLabel, peekCanWriteBack, peekFileCaption, sessionFilePath, titlebarHomeCopy } from './local-files';

test('会话文件路径:相对拼到 cwd,绝对的原样用', () => {
  assert.equal(sessionFilePath('/tmp/work', 'src/a.ts'), '/tmp/work/src/a.ts');
  assert.equal(sessionFilePath('/tmp/work/', '/abs/b.ts'), '/abs/b.ts');
  assert.equal(sessionFilePath('  /tmp/work  ', '  README.md  '), '/tmp/work/README.md');
  assert.equal(sessionFilePath('', 'only.ts'), 'only.ts');
});

test('文件预览过长就截断,并说清后面还有多少', () => {
  assert.equal(clipFilePeek('短'), '短');
  assert.match(clipFilePeek('x'.repeat(90_000), 80_000), /后面还有 10000 字/);
  assert.equal(isClippedFilePeek('短'), false);
  assert.equal(isClippedFilePeek(clipFilePeek('x'.repeat(90_000), 80_000)), true);
});

test('只有本机读完整正文才能写回,截断和远程都不动', () => {
  assert.equal(peekCanWriteBack({ machine: 'local', projectId: 'p1', path: '/tmp/a.ts', peek: 'hello' }), true);
  assert.equal(peekCanWriteBack({ machine: 'fold', projectId: 'p1', path: '/tmp/a.ts', peek: 'hello' }), false);
  assert.equal(peekCanWriteBack({ machine: 'local', projectId: '', path: '/tmp/a.ts', peek: 'hello' }), false);
  assert.equal(peekCanWriteBack({ machine: 'local', projectId: 'p1', path: '', peek: 'hello' }), false);
  assert.equal(peekCanWriteBack({ machine: 'local', projectId: 'p1', path: '/tmp/a.ts', peek: '正在读…' }), false);
  assert.equal(peekCanWriteBack({ machine: 'local', projectId: 'p1', path: '/tmp/a.ts', peek: '读不了:没有文件名' }), false);
  assert.equal(peekCanWriteBack({ machine: 'local', projectId: 'p1', path: '/tmp/a.ts', peek: clipFilePeek('x'.repeat(90_000), 80_000) }), false);
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const api = readFileSync(fileURLToPath(new URL('./api.ts', import.meta.url)), 'utf8');
  assert.match(app, /writeProjectFile/);
  assert.match(app, /peekCanWriteBack/);
  assert.match(app, /保存/);
  assert.match(app, /写回当前文件/);
  assert.match(api, /writeProjectFile/);
  assert.match(api, /PUT/);
});

test('产物相对名:cwd 下的绝对路径削掉前缀,相对的原样', () => {
  assert.equal(artifactNameFromPath('/tmp/work', '/tmp/work/src/a.ts'), 'src/a.ts');
  assert.equal(artifactNameFromPath('/tmp/work/', 'README.md'), 'README.md');
  assert.equal(artifactNameFromPath('/tmp/work', './src/a.ts'), 'src/a.ts');
});

test('2.0 壳本机点已改文件会打开文件抽屉,不是只倒工具输出', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /sessionFilePath/);
  assert.match(app, /readProjectFile/);
  assert.match(app, /readSessionArtifact/);
  assert.match(app, /openTouchedFile/);
  assert.match(app, /local-files-peek/);
  assert.match(app, /peekFileCaption/);
  assert.match(app, /local-files-name/);
  assert.match(app, /复制正文/);
  assert.match(app, /用默认程序打开/);
  assert.match(app, /openFocusFile/);
  assert.match(app, /isPeekDrawer/);
  assert.match(app, /mergeFilePins/);
  assert.doesNotMatch(app, /drawer !== 'diff'/);
  assert.doesNotMatch(app, /active\?\.machine === 'local' && next/);
  assert.doesNotMatch(app, /r\.output \|\| \(r\.running/);
});

test('本次改动和文件抽屉才读正文,终端也登记目录', () => {
  assert.equal(isPeekDrawer('files'), true);
  assert.equal(isPeekDrawer('diff'), true);
  assert.equal(isPeekDrawer('term'), false);
  assert.equal(isWorkspaceDrawer('term'), true);
  assert.equal(isWorkspaceDrawer('browser'), false);
});

test('预览标题只留文件名', () => {
  assert.equal(peekFileCaption('ART31.txt'), 'ART31.txt');
  assert.equal(peekFileCaption('/tmp/leo-codex-live/ART31.txt'), 'ART31.txt');
  assert.equal(peekFileCaption('  src\\foo\\bar.ts  '), 'bar.ts');
  assert.equal(peekFileCaption(''), '');
});

test('顶栏目录芯片只留最后一段', () => {
  assert.equal(cwdChipLabel('/tmp/leo-codex-live'), 'leo-codex-live');
  assert.equal(cwdChipLabel('/tmp/leo-codex-live/'), 'leo-codex-live');
  assert.equal(cwdChipLabel('~'), '~');
  assert.equal(cwdChipLabel(''), '');
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /cwdChipLabel/);
  assert.match(app, /复制目录/);
  assert.match(app, /v === 'cwd'/);
  assert.match(app, /复制标题/);
  assert.match(app, /v === 'title'/);
  assert.match(app, /copyTitle/);
  assert.match(app, /t: '复制标题'/);
  assert.match(app, /t: '复制目录'/);
  assert.match(app, /在 Finder 打开/);
  assert.match(app, /revealSessionPath/);
  assert.match(app, /pickSessionFolder/);
});

test('窗口顶条不重复长会话标题,只写主控和目录', () => {
  assert.deepEqual(titlebarHomeCopy({ hasSession: false }), { title: '主控', sub: '' });
  assert.deepEqual(
    titlebarHomeCopy({ hasSession: true, machineName: 'LeoyuandeMacBook-Pro-2.local', cwd: '/tmp/leo-codex-live' }),
    { title: '主控', sub: 'LeoyuandeMacBook-Pro-2 · leo-codex-live' },
  );
  assert.equal(machineChipLabel('LeoyuandeMacBook-Pro-2.local'), 'LeoyuandeMacBook-Pro-2');
  assert.equal(machineChipLabel('Fold'), 'Fold');
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /titlebarHomeCopy/);
  assert.match(app, /machineChipLabel\(g\.name\)/);
  assert.match(app, /machineChipLabel\(first\.machineName\)/);
  assert.match(app, /machineChipLabel\(activeGroup\?\.name\)/);
  assert.match(app, /machineChipLabel\(activeGroup\.name\)/);
  assert.doesNotMatch(app, /tb-title[\s\S]{0,180}\{title \|\| '新会话'\}/);
  const css = readFileSync(fileURLToPath(new URL('./v2.css', import.meta.url)), 'utf8');
  assert.match(css, /\.drawer\{[^}]*visibility:hidden/);
  assert.match(css, /\.drawer\.open\{[^}]*visibility:visible/);
});
