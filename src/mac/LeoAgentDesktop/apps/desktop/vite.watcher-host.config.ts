import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  build: {
    rollupOptions: {
      // watcher host 是 Electron utilityProcess 运行时。@parcel/watcher 是
      // native 模块(wrapper.js 动态 require 平台子包选 .node),必须在
      // packaged app 的 node_modules 中按平台解析,不能被 Vite bundle。
      // 实际加载走 createRequire + main 传入的绝对路径(见 watcherHostProcess.ts),
      // external 声明是防御:确保任何静态 import 形态也不会被打进 bundle。
      external: ['@parcel/watcher', '@parcel/watcher/wrapper.js'],
    },
  },
});
