import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      // preload.ts 用 `import('../main/...')` 仅取类型,Rollup 分析时仍会跟进
      // skillhub/scanner → gray-matter,触发 gray-matter JS 引擎里那段 eval 的警告。
      // 实际 bundle 已 tree-shake 掉 gray-matter (preload 运行期不依赖),警告纯噪音。
      // 只屏蔽这一处,保留对其他新增 eval 的告警能力。
      onwarn(warning, defaultHandler) {
        if (
          warning.code === 'EVAL' &&
          typeof warning.id === 'string' &&
          warning.id.replace(/\\/g, '/').includes('/gray-matter/lib/engines.js')
        ) {
          return;
        }
        defaultHandler(warning);
      },
    },
  },
});
