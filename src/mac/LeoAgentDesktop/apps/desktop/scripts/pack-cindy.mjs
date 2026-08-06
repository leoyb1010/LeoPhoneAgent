#!/usr/bin/env node
/**
 * 把一个意识源码目录打包成 .cindy 文件:
 *
 *   node apps/desktop/scripts/pack-cindy.mjs <目录> [输出路径]
 *
 * 例:node apps/desktop/scripts/pack-cindy.mjs ~/Desktop/cindy-ghosts/art ~/Desktop/cindy-ghosts/art.cindy
 * 目录根部必须有 ghost.json;缺省输出到当前目录 <id>.cindy。
 *
 * 意识源码**不入本仓库**(2026-07-09 Lizi 定案):意识是与 desktop 完全解耦的
 * 第三方内容,源码住用户自己的目录(如 ~/Desktop/cindy-ghosts/<id>/),.cindy
 * 也生成在那里——这正是「Maker 内置做意识」的
 * 真实用户形态,本脚本即其打包工具雏形。仓库里只留 QA 假人生成器
 * (make-demo-cindy.mjs)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'));
const JSZip = require('jszip');

const [dirArg, outArg] = process.argv.slice(2);
if (!dirArg) {
  console.error('用法:node pack-cindy.mjs <意识源码目录> [输出路径]');
  process.exit(1);
}
const dir = path.resolve(dirArg);
const manifestPath = path.join(dir, 'ghost.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`目录根部缺少 ghost.json:${dir}`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

const zip = new JSZip();
function addDir(abs, rel) {
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // .DS_Store 等隐藏文件不进包
    const absChild = path.join(abs, entry.name);
    const relChild = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) addDir(absChild, relChild);
    else zip.file(relChild, fs.readFileSync(absChild));
  }
}
addDir(dir, '');

const out = path.resolve(outArg ?? `${manifest.id ?? 'ghost'}.cindy`);
const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
fs.writeFileSync(out, buf);
console.log(`已打包 ${out}(${buf.length} 字节,id=${manifest.id},kind=${manifest.kind})`);
