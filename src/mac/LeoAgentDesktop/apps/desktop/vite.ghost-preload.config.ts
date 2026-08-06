import { defineConfig } from 'vite';

// 意识电子脑管子桥(src/preload/ghostPreload.ts)的构建配置:借 preload
// target 出 CJS 单文件,产物与 main bundle 同目录(.vite/build/ghostPreload.js),
// 运行时由 electronSandboxAdapter 按 __dirname 相对定位。
export default defineConfig({});
