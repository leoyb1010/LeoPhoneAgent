import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  build: {
    rollupOptions: {
      // db worker 是 Node worker_threads 运行时，原生模块必须在 packaged
      // app 的 node_modules / resources 中按平台解析，不能被 Vite bundle。
      external: [
        'better-sqlite3',
        'sqlite-vec',
        'drizzle-orm/better-sqlite3',
      ],
    },
  },
});
