// 1.1.6：测试共享的固定源码读取与精确补丁应用（原先 10 个测试文件各自复制一份 patched()）。
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

export const source = process.env.PAPERCLIP_SOURCE;
export const candidate = process.env.PAPERCLIP_CANDIDATE;

export function readJson(relative) {
  return JSON.parse(fs.readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8'));
}

/** 固定提交中的原始文件（不读取已打补丁的工作区）。 */
export function original(file, root = source) {
  return execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 20e6 });
}

/** 依次精确应用补丁：每条上下文出现次数必须等于 expected（默认 1），用 split/join 避免 $ 替换模式。 */
export function applyPatches(text, patches, file, message = `pinned patch context: ${file}`) {
  for (const patch of patches.filter(p => p.file === file)) {
    assert.equal(text.split(patch.from).length - 1, patch.expected ?? 1, message);
    text = text.split(patch.from).join(patch.to);
  }
  return text;
}

/**
 * 读取固定源码并应用补丁。reversible=true 时额外确认把 to 换回 from 能还原原文件，
 * 即除了审阅过的片段外没有其他改动。
 */
export function patched(file, patches, { root = source, reversible = false, message } = {}) {
  const base = original(file, root);
  const text = applyPatches(base, patches, file, message);
  if (reversible) {
    let restored = text;
    for (const patch of patches.filter(p => p.file === file)) restored = restored.split(patch.to).join(patch.from);
    assert.equal(restored, base, `only reviewed patch sites change: ${file}`);
  }
  return text;
}
