import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const root = new URL('../app/entry/src/main/ets/', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8');

test('首页默认使用紧凑输入区，把连续滚动空间留给会话', () => {
  const pane = read('panes/LocalAgentPane.ets');
  assert.ok(pane.includes('compact: this.viewportHeight < 900'));
  const composer = read('chat/Composer.ets');
  assert.ok(composer.includes('this.showMic && (!this.compactActions() || !this.canSend() || this.running)'));
  assert.ok(composer.includes('if (!this.compactActions() || this.canSend() || this.running) SurfaceButton'));
});

test('首页背景延伸覆盖底部手势区且没有独立背景假横条', () => {
  const page = read('pages/HomePage.ets');
  assert.ok(page.includes('.expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])'));
});

test('发布门禁以当前版本对象而不是旧 first 变量校验', () => {
  const script = fs.readFileSync(new URL('../../../../../scripts/verify_harmony_release_notes.sh', root), 'utf8');
  assert.ok(script.includes('current\\.version'));
  assert.ok(!script.includes("first\\.version"));
});
