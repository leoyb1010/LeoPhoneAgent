import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * [T-release-notes] 发版铁律的自动闸门。
 *
 * 铁律写在 CLAUDE.md 里已经很久了,1.68.0 还是漏了 —— 靠人记等于没有。
 * 这里把"当前版本必须有更新说明"变成 npm test 会挂的硬失败,发版链上跑
 * 不过去,漏不掉。
 *
 * 用正则读源文件而不是 import:releaseNotes.ts 里有 import.meta.env,
 * node --test 直接加载会炸,而这层校验只关心那张表的字面内容。
 */

const packageVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
).version as string;

const source = readFileSync(fileURLToPath(new URL('./releaseNotes.ts', import.meta.url)), 'utf8');

/** 按出现顺序取出表里的版本号。第一个即"最新一条"。 */
function declaredVersions(): string[] {
  return [...source.matchAll(/version:\s*'([^']+)'/g)].map((m) => m[1]);
}

test('package.json 的版本在 LEO_RELEASE_NOTES 里有对应条目', () => {
  const versions = declaredVersions();
  assert.ok(
    versions.includes(packageVersion),
    `发版铁律:package.json 是 ${packageVersion},但 LEO_RELEASE_NOTES 里没有这一条。` +
      `请在 releaseNotes.ts 最前面补上(版本、日期、这次改了什么),否则装机后弹不出"本次更新"。`,
  );
});

test('最新条目就是当前版本,排在最前面', () => {
  const versions = declaredVersions();
  assert.equal(
    versions[0],
    packageVersion,
    `发版铁律:LEO_RELEASE_NOTES 第一条应该是当前版本 ${packageVersion},实际是 ${versions[0]}。` +
      `新版本要插在数组最前面 —— 弹卡和"查看全部"都按这个顺序展示。`,
  );
});

test('当前版本的条目有日期,而且至少写了一件事', () => {
  // 抓当前版本那一段:从它的 version 行到下一个 version 行(或数组结束)之前。
  const start = source.indexOf(`version: '${packageVersion}'`);
  assert.ok(start > 0, `找不到 ${packageVersion} 的条目`);
  const rest = source.slice(start + 1);
  const nextVersion = rest.indexOf('version: ');
  const block = nextVersion === -1 ? rest : rest.slice(0, nextVersion);

  assert.match(block, /date:\s*'\d{4}-\d{2}-\d{2}'/, `${packageVersion} 的条目缺 date(YYYY-MM-DD)`);

  const items = [...block.matchAll(/'([^']{4,})'/g)].map((m) => m[1]).filter((s) => !/^\d{4}-\d{2}-\d{2}$/.test(s));
  assert.ok(
    items.length > 0,
    `${packageVersion} 的 items 是空的 —— 更新提示弹出来必须真的说清这次改了什么`,
  );
});
