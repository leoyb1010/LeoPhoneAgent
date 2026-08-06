#!/usr/bin/env node
/**
 * generate-mac-icns.mjs — 从 1024x1024 满幅方形母版生成 macOS 的 icon.icns。
 *
 * 为什么需要它:macOS 不会自动给 app 图标加圆角(macOS 26 Tahoe 开始系统才
 * 强制套遮罩),圆角必须"画"在 icns 文件里。直接把满幅方图打进 icns,在
 * Tahoe 之前的所有 macOS 上 Dock / Finder 里都会显示成方块。
 *
 * 本脚本按 Apple 官方图标网格 (Big Sur+ Icon Grid) 处理:
 *   - 1024x1024 画布,内容缩至 824x824 居中(四周各 100px 透明边距);
 *   - 824x824 内容套 185.4px 圆角遮罩(Apple 模板标准值);
 *   - 从圆角后的 1024 母版降采样出全套尺寸,打包成 icns。
 *
 * 块格式与 Apple iconutil 产物对齐:
 *   - PNG 块: ic07(128) ic08(256) ic09(512) ic10(1024) ic11(16@2x)
 *             ic12(32@2x) ic13(128@2x) ic14(256@2x)
 *   - ARGB 块(icns RLE 压缩): ic04(16) ic05(32) —— 老版本 macOS 的
 *     Finder 小图标取这两块。
 *
 * 同时在 out.icns 同目录产出 icon-dock.png(512x512,已套圆角+边距):
 * mac dev 跑的是 node_modules 里的官方 Electron 二进制,icns 用不上,
 * bootstrap-electron.ts 里 dev-only 的 app.dock.setIcon 需要一张平铺 PNG,
 * setIcon 原样显示不加遮罩,给它满幅方图 Dock 就是方块,必须用这张。
 *
 * 用法(仓库根或 apps/desktop 下执行均可):
 *   node apps/desktop/scripts/generate-mac-icns.mjs [master.png] [out.icns]
 *   默认: master = apps/desktop/resources/icon-master-1024.png
 *         out    = apps/desktop/resources/icon.icns
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resourcesDir = path.join(__dirname, '..', 'resources');

const masterPath = process.argv[2] ?? path.join(resourcesDir, 'icon-master-1024.png');
const outPath = process.argv[3] ?? path.join(resourcesDir, 'icon.icns');

// Apple Big Sur+ 图标网格常量(相对 1024 画布)
const CANVAS = 1024;
const CONTENT = 824;
const RADIUS = 185.4;
const MARGIN = (CANVAS - CONTENT) / 2;

/**
 * icns 的 RLE 压缩(is32 / it32 / ARGB 块通用的 PackBits 变体):
 *   - 控制字节 < 0x80: 后跟 (n+1) 个字面量字节
 *   - 控制字节 >= 0x80: 后 1 个字节重复 (n - 0x80 + 3) 次
 */
function icnsRleEncode(channel) {
  const out = [];
  let i = 0;
  while (i < channel.length) {
    // 找 run(>=3 个相同字节才值得用 run 编码)
    let runLen = 1;
    while (
      runLen < 130 &&
      i + runLen < channel.length &&
      channel[i + runLen] === channel[i]
    ) {
      runLen++;
    }
    if (runLen >= 3) {
      out.push(0x80 + runLen - 3, channel[i]);
      i += runLen;
      continue;
    }
    // 字面量段:收集到下一个 run 开始或攒满 128 个
    const litStart = i;
    let litLen = 0;
    while (litLen < 128 && i < channel.length) {
      let nextRun = 1;
      while (
        nextRun < 3 &&
        i + nextRun < channel.length &&
        channel[i + nextRun] === channel[i]
      ) {
        nextRun++;
      }
      if (nextRun >= 3 && i + nextRun < channel.length && channel[i + nextRun] === channel[i]) break;
      i++;
      litLen++;
    }
    out.push(litLen - 1, ...channel.subarray(litStart, litStart + litLen));
  }
  return Buffer.from(out);
}

/** 把 RGBA 像素编码成 icns 的 ARGB 块数据("ARGB" magic + 各通道 RLE) */
function encodeArgbChunkData(rgba, size) {
  const n = size * size;
  const a = Buffer.alloc(n);
  const r = Buffer.alloc(n);
  const g = Buffer.alloc(n);
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    r[i] = rgba[i * 4];
    g[i] = rgba[i * 4 + 1];
    b[i] = rgba[i * 4 + 2];
    a[i] = rgba[i * 4 + 3];
  }
  return Buffer.concat([
    Buffer.from('ARGB', 'ascii'),
    icnsRleEncode(a),
    icnsRleEncode(r),
    icnsRleEncode(g),
    icnsRleEncode(b),
  ]);
}

function chunk(type, data) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 'ascii');
  header.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([header, data]);
}

async function main() {
  if (!fs.existsSync(masterPath)) {
    console.error(`[generate-mac-icns] master image missing: ${masterPath}`);
    process.exit(1);
  }

  // 1. 母版 → 824x824 → 套圆角 → 居中放到 1024 透明画布
  const roundedMask = Buffer.from(
    `<svg width="${CONTENT}" height="${CONTENT}"><rect width="${CONTENT}" height="${CONTENT}" rx="${RADIUS}" ry="${RADIUS}" fill="#fff"/></svg>`,
  );
  const content = await sharp(masterPath)
    .resize(CONTENT, CONTENT, { fit: 'cover' })
    .ensureAlpha()
    .composite([{ input: roundedMask, blend: 'dest-in' }])
    .png()
    .toBuffer();
  const master1024 = await sharp(content)
    .extend({
      top: MARGIN,
      bottom: MARGIN,
      left: MARGIN,
      right: MARGIN,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  // 2. 降采样出各尺寸
  const sizePng = async (size) =>
    sharp(master1024).resize(size, size).png().toBuffer();
  const sizeRgba = async (size) =>
    sharp(master1024).resize(size, size).ensureAlpha().raw().toBuffer();

  // PNG 块: type → 像素尺寸(ic04/ic05 走 ARGB,不在此表)
  const pngTypes = [
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
    ['ic11', 32], // 16pt @2x
    ['ic12', 64], // 32pt @2x
    ['ic13', 256], // 128pt @2x
    ['ic14', 512], // 256pt @2x
  ];

  const chunks = [];
  chunks.push(chunk('ic04', encodeArgbChunkData(await sizeRgba(16), 16)));
  chunks.push(chunk('ic05', encodeArgbChunkData(await sizeRgba(32), 32)));
  for (const [type, size] of pngTypes) {
    chunks.push(chunk(type, await sizePng(size)));
  }

  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  fs.writeFileSync(outPath, Buffer.concat([header, body]));

  const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(0);
  console.log(`[generate-mac-icns] wrote ${outPath} (${sizeKb} KB, ${chunks.length} chunks)`);

  // 3. dev Dock 用的平铺 PNG(见文件顶注)
  const dockPngPath = path.join(path.dirname(outPath), 'icon-dock.png');
  fs.writeFileSync(dockPngPath, await sizePng(512));
  console.log(`[generate-mac-icns] wrote ${dockPngPath}`);
}

main().catch((err) => {
  console.error('[generate-mac-icns] failed:', err);
  process.exit(1);
});
