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
      // @cindy/im 必须零 Electron 依赖 —— 任何 electron / electron-* import 都报错。
      // 所有 Electron 适配在 host 层（apps/desktop/src/main/im-host.ts）实现，
      // 通过 IMHost adapter 注入（secrets / ipc / paths）。
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'electron/*', 'electron-*'],
              message: '@cindy/im 不能依赖 Electron。所有 Electron 适配在 host 层（apps/desktop/src/main/im-host.ts）实现，通过 IMHost 注入。',
            },
          ],
        },
      ],
    },
  },
);
