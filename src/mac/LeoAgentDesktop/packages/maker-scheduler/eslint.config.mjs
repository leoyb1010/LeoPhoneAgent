import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/'],
  },
  {
    rules: {
      // @cindy/maker-scheduler 是零运行时依赖核心包（RFC §3.1 / Phase 7 §「CI 守门」）：
      // - 不能依赖 Electron / drizzle / better-sqlite3（host 层注入）
      // - 不能反向依赖任何 host 侧包：maker-core / @cindy/im / @cindy/mcps
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'electron/*', 'electron-*'],
              message: '@cindy/maker-scheduler 不能依赖 Electron。所有 Electron 适配在 apps/desktop/src/main/scheduler-host/ 实现。',
            },
            {
              group: ['drizzle-orm', 'drizzle-orm/*', 'better-sqlite3'],
              message: '@cindy/maker-scheduler 不能依赖具体存储实现。Storage 通过 ScheduleStorage 接口注入。',
            },
            {
              group: ['@cindy/maker-core', '@cindy/maker-core/*'],
              message: '@cindy/maker-scheduler 不能依赖 maker-core。所有 maker 集成在 host 层（apps/desktop/src/main/scheduler-host/runner.ts）实现。',
            },
            {
              group: ['@cindy/im', '@cindy/im/*', '@cindy/@cindy/im', '@cindy/@cindy/im/*'],
              message: '@cindy/maker-scheduler 不能依赖 @cindy/im。Notifier 接口注入飞书能力。',
            },
            {
              group: ['@cindy/mcps', '@cindy/mcps/*', '@cindy/@cindy/mcps', '@cindy/@cindy/mcps/*'],
              message: '@cindy/maker-scheduler 不能依赖 @cindy/mcps（依赖图反向）。',
            },
          ],
        },
      ],
    },
  },
);
