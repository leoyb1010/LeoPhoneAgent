import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const page = fs.readFileSync(new URL('../app/entry/src/main/ets/pages/BrainSpacePage.ets', import.meta.url), 'utf8');
const enter = page.slice(page.indexOf('  private async enter()'), page.indexOf('  private async configure()'));
const api = fs.readFileSync(new URL('../app/entry/src/main/ets/brain/BrainAPI.ets', import.meta.url), 'utf8');

test('已配置第二大脑冷启动直接加载，不先强制生物识别', () => {
  assert.ok(page.includes('if (cfg.token.length > 0) this.enter();'));
  assert.doesNotMatch(enter, /BrainAPI\.unlock\(/);
  assert.ok(page.includes("else if (this.mode === 'home')"));
});

test('普通浏览不再依赖 unlocked 标志，敏感媒体仍由底层解锁门禁保护', () => {
  assert.ok(page.includes('else if (this.mode === \'web\')'));
  assert.ok(page.includes('else if (this.mode === \'home\')'));
  assert.ok(!page.includes('else if (!this.unlocked)'));
  assert.ok(page.includes('BrainImage({ fileId: r.image'));
  assert.ok(api.includes('static async bytes(path: string): Promise<ArrayBuffer> {\n    BrainAPI.requireUnlocked();'));
});

test('问答支持停止等待、同 id 继续等待与 Markdown 回答', () => {
  assert.ok(page.includes('@State answerWaiting: boolean = false'));
  assert.ok(page.includes('private answerPollGeneration: number = 0'));
  assert.ok(page.includes('private async resumeAnswer(): Promise<void>'));
  assert.ok(page.includes("'停止等待'"));
  assert.ok(page.includes("'继续等待'"));
  assert.ok(page.includes('MarkdownText({ content: this.answer })'));
});

test('版本测试跟随当前目录且检查真实相邻历史', () => {
  const source = fs.readFileSync(new URL('../protocol/ui-tokens.test.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("assert.equal(release.currentVersion, '0.5.4')"));
  assert.ok(source.includes("assert.equal(release.currentBuild, 100033)"));
  assert.ok(source.includes("assert.equal(notes[1].version, '0.5.3')"));
});
