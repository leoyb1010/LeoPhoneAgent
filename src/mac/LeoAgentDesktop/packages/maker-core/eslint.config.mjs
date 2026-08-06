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
      // maker-core 必须零 Electron 依赖——任何对 electron / electron-* 的 import 都报错。
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'electron/*', 'electron-*'],
              message: '@cindy/maker-core 不能依赖 Electron。所有 Electron 适配在 host 层（apps/desktop/src/main/maker-host/）实现，通过依赖注入传给 Maker。',
            },
            {
              group: ['@cindy/maker-scheduler', '@cindy/maker-scheduler/*'],
              message: '@cindy/maker-core 不能依赖 @cindy/maker-scheduler（反向依赖）。scheduler 在 host 层组装并消费 maker-core，maker-core 不感知调度。',
            },
          ],
        },
      ],
    },
  },
);
